"""Resolve a raw `Criteria` (may contain `SegmentFilter` refs) into a
form that the SQL compiler can consume (only `NestedFilter` for nested
shapes).

Conditional-attach pattern: criteria with no operational-data-aware
filter kinds skip the operational PG attach + segments lookup entirely.
Criteria that do reference segments pay the lookup once per request
(amortized further by DuckDB's cached connection / `ATTACH IF NOT EXISTS`).

When other operational-data-aware filter kinds land (canvass-result
filter etc.), each contributes its own short-circuit check + resolution
step here.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from src.duckdb import OPERATIONAL_PG_ALIAS, attach_operational_postgres

from .criteria import Criteria, NestedFilter, SegmentFilter
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
    """Resolve any operational-data-aware filters in `criteria`. Today that's
    `SegmentFilter`; new kinds plug in here. Returns the original criteria
    unchanged if it doesn't need resolution."""
    if not _has_segment_refs(criteria):
        return criteria
    attach_operational_postgres(conn, settings)
    segments = _load_segments_for_org(conn, org_slug)
    return expand_segment_refs(criteria, segments)


def _has_segment_refs(criteria: Criteria) -> bool:
    for step in criteria.steps:
        f = step.filter
        if isinstance(f, SegmentFilter):
            return True
        if isinstance(f, NestedFilter) and _has_segment_refs(f.criteria):
            return True
    return False


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
