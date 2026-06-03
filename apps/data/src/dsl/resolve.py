"""Resolve a raw `Criteria` (may contain `SegmentFilter` refs) into a
form that the SQL compiler can consume (only `NestedFilter` for nested
shapes).

Conditional-attach pattern: criteria with no operational-data-aware
filter kinds skip the operational PG attach + segments lookup entirely.
Criteria that do reference segments pay the lookup once per request
(amortized further by DuckDB's cached connection / `ATTACH IF NOT EXISTS`).

Operational-data-aware kinds each contribute a short-circuit check plus a
resolution pass here: `SegmentFilter` inlines to `NestedFilter`, and
`CanvassOutcomeFilter` reduces the canvass log to the matching person-id set
(`PersonIdSetFilter`). Segments are expanded first so a referenced segment
that itself contains a canvass filter gets inlined before canvass resolution
walks the tree.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from src.duckdb import OPERATIONAL_PG_ALIAS, attach_operational_postgres

from .criteria import (
    CanvassOutcomeFilter,
    CanvassResponseFilter,
    Criteria,
    NestedFilter,
    PersonIdSetFilter,
    SegmentFilter,
    Step,
)
from .expand import SegmentLike, expand_segment_refs

if TYPE_CHECKING:
    import duckdb
    from src.settings import Settings


def resolve_criteria(
    criteria: Criteria,
    conn: duckdb.DuckDBPyConnection,
    settings: Settings,
    org_slug: str,
) -> Criteria:
    """Resolve any operational-data-aware filters in `criteria`. Returns the
    original criteria unchanged if it doesn't need resolution."""
    needs_segments = _has_segment_refs(criteria)
    needs_canvass = _has_canvass_refs(criteria)
    if not needs_segments and not needs_canvass:
        return criteria
    attach_operational_postgres(conn, settings)
    if needs_segments:
        segments = _load_segments_for_org(conn, org_slug)
        criteria = expand_segment_refs(criteria, segments)
    if needs_canvass:
        criteria = _resolve_canvass_refs(criteria, conn, org_slug)
    return criteria


def _has_segment_refs(criteria: Criteria) -> bool:
    for step in criteria.steps:
        f = step.filter
        if isinstance(f, SegmentFilter):
            return True
        if isinstance(f, NestedFilter) and _has_segment_refs(f.criteria):
            return True
    return False


def _has_canvass_refs(criteria: Criteria) -> bool:
    for step in criteria.steps:
        f = step.filter
        if isinstance(f, (CanvassOutcomeFilter, CanvassResponseFilter)):
            return True
        if isinstance(f, NestedFilter) and _has_canvass_refs(f.criteria):
            return True
    return False


def _resolve_canvass_refs(
    criteria: Criteria,
    conn: duckdb.DuckDBPyConnection,
    org_slug: str,
) -> Criteria:
    """Replace each canvass filter (`CanvassOutcomeFilter`,
    `CanvassResponseFilter`) with the `PersonIdSetFilter` of persons whose
    current result matches. A filter with nothing selected is inactive —
    dropped entirely, exactly as the compiler skips an empty filter clause (no
    effect under any verb), avoiding an invalid `IN ()`."""
    new_steps: list[Step] = []
    for step in criteria.steps:
        f = step.filter
        if isinstance(f, CanvassOutcomeFilter):
            if not f.outcomes:
                continue
            ids = _canvass_outcome_person_ids(conn, org_slug, f.outcomes)
            new_steps.append(Step(verb=step.verb, filter=PersonIdSetFilter(kind="person-id-set", ids=ids)))
        elif isinstance(f, CanvassResponseFilter):
            if not f.option_ids:
                continue
            ids = _canvass_response_person_ids(conn, org_slug, f.question_id, f.option_ids)
            new_steps.append(Step(verb=step.verb, filter=PersonIdSetFilter(kind="person-id-set", ids=ids)))
        elif isinstance(f, NestedFilter):
            inner = _resolve_canvass_refs(f.criteria, conn, org_slug)
            new_steps.append(Step(verb=step.verb, filter=NestedFilter(kind="nested", criteria=inner)))
        else:
            new_steps.append(step)
    return Criteria(steps=new_steps)


def _canvass_outcome_person_ids(
    conn: duckdb.DuckDBPyConnection,
    org_slug: str,
    outcomes: list[str],
) -> list[str]:
    """Persons (by `external_id`) whose *current* result in some turf has an
    outcome in `outcomes`. Reduces the append-only log to the latest result
    per `(turf, person)` by `sequence` (the snapshot model makes that the whole
    reduction — newest result is the entity's full current disposition), then
    keeps those whose outcome is selected. Org-scoped via turf → campaign →
    organization for tenant isolation. v1 is existential across turfs (no
    recency / campaign / cross-turf-collapse knobs yet)."""
    placeholders = ", ".join("?" for _ in outcomes)
    rows = conn.execute(
        f"""
        SELECT DISTINCT person_id FROM (
            SELECT
                e.person_id,
                json_extract_string(CAST(e.payload AS VARCHAR), '$.outcome') AS outcome
            FROM {OPERATIONAL_PG_ALIAS}.public.canvass_events e
            JOIN {OPERATIONAL_PG_ALIAS}.public.turfs t ON t.turf_id = e.turf_id
            JOIN {OPERATIONAL_PG_ALIAS}.public.campaigns c ON c.campaign_id = t.campaign_id
            JOIN {OPERATIONAL_PG_ALIAS}.public.organizations o
                ON o.organization_id = c.organization_id
            WHERE e.kind = 'result'
                AND e.person_id IS NOT NULL
                AND o.slug = ?
            QUALIFY row_number() OVER (
                PARTITION BY e.turf_id, e.person_id ORDER BY e.sequence DESC
            ) = 1
        )
        WHERE outcome IN ({placeholders})
        """,
        [org_slug, *outcomes],
    ).fetchall()
    return [r[0] for r in rows]


def _canvass_response_person_ids(
    conn: duckdb.DuckDBPyConnection,
    org_slug: str,
    question_id: str,
    option_ids: list[str],
) -> list[str]:
    """Persons (by `external_id`) whose *current* result in some turf answered
    `question_id` with one of `option_ids`. Same latest-per-(turf, person)
    reduction as `_canvass_outcome_person_ids`; then overlaps the question's selected
    option ids against the filter set. Free-text answers and unanswered
    questions never match (no `optionIds` → NULL list). v1 is existential
    across turfs, unscoped — see `_canvass_outcome_person_ids`."""
    # Built here but passed as a bind param (never interpolated into the SQL),
    # so the question id can't inject. Same json_extract idiom as the outcome
    # query above, just pulling an array rather than a scalar.
    options_path = f'$.responses."{question_id}".optionIds'
    rows = conn.execute(
        f"""
        SELECT DISTINCT person_id FROM (
            SELECT
                e.person_id,
                CAST(json_extract(CAST(e.payload AS VARCHAR), ?) AS VARCHAR[]) AS selected
            FROM {OPERATIONAL_PG_ALIAS}.public.canvass_events e
            JOIN {OPERATIONAL_PG_ALIAS}.public.turfs t ON t.turf_id = e.turf_id
            JOIN {OPERATIONAL_PG_ALIAS}.public.campaigns c ON c.campaign_id = t.campaign_id
            JOIN {OPERATIONAL_PG_ALIAS}.public.organizations o
                ON o.organization_id = c.organization_id
            WHERE e.kind = 'result'
                AND e.person_id IS NOT NULL
                AND o.slug = ?
            QUALIFY row_number() OVER (
                PARTITION BY e.turf_id, e.person_id ORDER BY e.sequence DESC
            ) = 1
        )
        WHERE list_has_any(selected, ?)
        """,
        [options_path, org_slug, option_ids],
    ).fetchall()
    return [r[0] for r in rows]


def _load_segments_for_org(conn: duckdb.DuckDBPyConnection, org_slug: str) -> dict[str, SegmentLike]:
    rows = conn.execute(
        f"""
        SELECT s.segment_id::VARCHAR, s.name, s.criteria::VARCHAR
        FROM {OPERATIONAL_PG_ALIAS}.public.segments s
        JOIN {OPERATIONAL_PG_ALIAS}.public.organizations o
            ON o.organization_id = s.organization_id
        WHERE o.slug = ?
        """,
        [org_slug],
    ).fetchall()
    return {
        seg_id: SegmentLike(
            segment_id=seg_id,
            name=name,
            criteria=Criteria.model_validate(json.loads(criteria_json) if criteria_json else {}),
        )
        for seg_id, name, criteria_json in rows
    }
