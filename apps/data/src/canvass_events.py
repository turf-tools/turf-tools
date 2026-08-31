"""Read path over the canvass event log (app.canvass_events).

Two reduction rules shared by every reporting surface, both "latest
result by event sequence within the requested scope": per person (the
current-state grain behind funnel stages and response counts) and per
(person, walk) (the attempt grain behind the row-level reports). The
person grain is the attempt grain reduced once more, so counts derived
from either reconcile by construction. The `*_cte` builders produce the
reduction; the aggregate builders read a materialized relation by name
(src.duckdb.materialize), so each request reduces the log once.
Builders name operational Postgres through OPERATIONAL_PG_ALIAS, so
tests attach a synthetic in-memory catalog under the same alias and run
the exact production SQL.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from src.duckdb import OPERATIONAL_PG_ALIAS


@dataclass
class EventScope:
    """Event-log WHERE fragments, split in two: `base` (org + campaigns)
    feeds the canvass-day list, which must ignore date filters — the
    picker's options would otherwise collapse to the current pick;
    `event` adds the date window for the reduction itself."""

    base_filters: list[str]
    base_params: list[Any]
    event_filters: list[str]
    event_params: list[Any]


def event_scope(
    org_slug: str,
    campaign_ids: list[str] | None = None,
    start: str | None = None,
    end: str | None = None,
    day: str | None = None,
    tz: str = "America/New_York",
) -> EventScope:
    base_filters = ["e.kind = 'result'", "e.person_id IS NOT NULL", "o.slug = ?"]
    base_params: list[Any] = [org_slug]
    if campaign_ids:
        base_filters.append("c.campaign_id::VARCHAR IN (SELECT unnest(?))")
        base_params.append(list(campaign_ids))
    event_filters = [*base_filters]
    event_params: list[Any] = [*base_params]
    if start:
        event_filters.append("e.created_at >= ?::TIMESTAMPTZ")
        event_params.append(start)
    if end:
        event_filters.append("e.created_at <= ?::TIMESTAMPTZ")
        event_params.append(end)
    if day:
        # Day boundaries in the display timezone so DST can't shift them.
        event_filters.append("(e.created_at AT TIME ZONE ?)::DATE = ?::DATE")
        event_params.extend([tz, day])
    return EventScope(base_filters, base_params, event_filters, event_params)


def latest_results_cte(persons_fqn: str, where: str, event_filters: list[str]) -> str:
    """WITH block reducing events to each person's latest result, joined
    to the conditioned population (`where` over `persons_fqn`; empty =
    everyone). Queries built on it bind the event params first, then the
    criteria params."""
    return f"""
        WITH latest AS (
            SELECT * FROM (
                SELECT
                    e.person_id,
                    json_extract_string(CAST(e.payload AS VARCHAR), '$.outcome') AS outcome,
                    json_extract(CAST(e.payload AS VARCHAR), '$.responses') AS responses,
                    t.zone_id::VARCHAR AS zone_id,
                    t.zone_name,
                    e.sequence
                FROM {OPERATIONAL_PG_ALIAS}.app.canvass_events e
                JOIN {OPERATIONAL_PG_ALIAS}.app.turfs t ON t.turf_id = e.turf_id
                JOIN {OPERATIONAL_PG_ALIAS}.app.campaigns c ON c.campaign_id = t.campaign_id
                JOIN {OPERATIONAL_PG_ALIAS}.app.organizations o
                    ON o.organization_id = c.organization_id
                WHERE {" AND ".join(event_filters)}
                QUALIFY row_number() OVER (
                    PARTITION BY e.person_id ORDER BY e.sequence DESC
                ) = 1
            )
        ),
        pop AS (
            SELECT external_id FROM {persons_fqn} {where}
        ),
        joined AS (
            SELECT l.* FROM latest l JOIN pop p ON p.external_id = l.person_id
        )
    """


def stages_sql(rel: str) -> str:
    """Per-zone funnel stages over `rel`, a materialized latest-result
    relation (see `latest_results_cte` + `materialize`)."""
    return f"""
        SELECT
            zone_id,
            any_value(zone_name) AS zone_name,
            count(*) FILTER (WHERE outcome IS NOT NULL) AS attempted,
            count(*) FILTER (WHERE outcome = 'canvassed') AS contacted
        FROM {rel}
        GROUP BY zone_id
        """


def responses_sql(rel: str) -> str:
    """Per-zone option counts among the contacted, over a materialized
    latest-result relation."""
    return f"""
        SELECT zone_id, q.question_id, o.option_id, count(*) AS n
        FROM {rel},
             UNNEST(json_keys(responses)) AS q(question_id),
             UNNEST(CAST(json_extract(responses,
                 '$."' || q.question_id || '".optionIds') AS VARCHAR[])) AS o(option_id)
        WHERE outcome = 'canvassed'
        GROUP BY 1, 2, 3
        """


def answered_sql(rel: str) -> str:
    """Per-zone count of contacted people who answered each question at
    all — non-empty optionIds or text. The completion stat for questions
    whose answers aren't option counts (open-ended). Reads a materialized
    latest-result relation."""
    return f"""
        SELECT zone_id, q.question_id, count(*) AS n
        FROM {rel},
             UNNEST(json_keys(responses)) AS q(question_id)
        WHERE outcome = 'canvassed'
          AND (
            len(CAST(json_extract(responses,
                '$."' || q.question_id || '".optionIds') AS VARCHAR[])) > 0
            OR coalesce(json_extract_string(responses,
                '$."' || q.question_id || '".text'), '') <> ''
          )
        GROUP BY 1, 2
        """


def attempts_cte(persons_fqn: str, where: str, event_filters: list[str]) -> str:
    """WITH block reducing events to attempts — the latest result per
    (person, walk) — joined to the conditioned population. Events
    without a walk_id (pre-stamp clients) group by canvass day in the
    display timezone instead. A person whose scope-wide latest result
    is a clear contributes no attempts: a clear means the record was a
    mistake, erasing attempt history too, so attempt-derived counts
    match the person grain by construction. Queries built on it bind
    the event params, then the fallback tz, then the criteria params."""
    return f"""
        WITH attempt_latest AS (
            SELECT * FROM (
                SELECT
                    e.person_id,
                    e.walk_id::VARCHAR AS walk_id,
                    e.canvasser_name,
                    e.canvasser_phone,
                    json_extract_string(CAST(e.payload AS VARCHAR), '$.outcome') AS outcome,
                    json_extract(CAST(e.payload AS VARCHAR), '$.responses') AS responses,
                    t.zone_id::VARCHAR AS zone_id,
                    t.zone_name,
                    t.name AS turf_name,
                    c.name AS campaign,
                    c.organization_id,
                    e.created_at,
                    e.sequence,
                    first_value(json_extract_string(CAST(e.payload AS VARCHAR), '$.outcome'))
                        OVER (PARTITION BY e.person_id ORDER BY e.sequence DESC)
                        AS current_outcome
                FROM {OPERATIONAL_PG_ALIAS}.app.canvass_events e
                JOIN {OPERATIONAL_PG_ALIAS}.app.turfs t ON t.turf_id = e.turf_id
                JOIN {OPERATIONAL_PG_ALIAS}.app.campaigns c ON c.campaign_id = t.campaign_id
                JOIN {OPERATIONAL_PG_ALIAS}.app.organizations o
                    ON o.organization_id = c.organization_id
                WHERE {" AND ".join(event_filters)}
                QUALIFY row_number() OVER (
                    PARTITION BY e.person_id, coalesce(
                        e.walk_id::VARCHAR,
                        ((e.created_at AT TIME ZONE ?)::DATE)::VARCHAR)
                    ORDER BY e.sequence DESC
                ) = 1
            )
        ),
        attempt_pop AS (
            SELECT external_id FROM {persons_fqn} {where}
        ),
        attempts AS (
            SELECT a.* FROM attempt_latest a
            JOIN attempt_pop p ON p.external_id = a.person_id
            WHERE a.outcome IS NOT NULL AND a.current_outcome IS NOT NULL
        )
    """


def walk_stats_sql(rel: str) -> str:
    """Per-walk tallies over `rel`, a materialized attempt-grain relation
    (see `attempts_cte` + `materialize`; attempts are already
    outcome-bearing, so attempted = row count). Walkless attempts from
    pre-stamp clients have no walk to attribute to and are absent; walk
    rows and their sign-out lookups join in at the endpoint, so
    sign-outs with no attempts zero-fill there. Activity timestamps
    come back as UTC ISO strings (display-tz formatting is the
    endpoint's job)."""
    return f"""
        SELECT
            walk_id,
            count(*) AS attempted,
            count(*) FILTER (WHERE outcome = 'canvassed') AS contacted,
            min(created_at)::VARCHAR AS first_activity,
            max(created_at)::VARCHAR AS last_activity
        FROM {rel}
        WHERE walk_id IS NOT NULL
        GROUP BY walk_id
        """


def canvasser_stats_sql(rel: str) -> str:
    """Per-canvasser tallies over a materialized attempt-grain relation.
    Identity is the claimed attestation — phone where present, else name
    — and the display name is the most recently claimed one. Everything
    derives from attempts, so a canvasser exists only with ≥1 attempt
    and sign-outs with no attempts don't count as walks."""
    return f"""
        SELECT
            coalesce(canvasser_phone, canvasser_name) AS canvasser_key,
            arg_max(canvasser_name, sequence) AS canvasser_name,
            arg_max(canvasser_phone, sequence) AS canvasser_phone,
            count(DISTINCT walk_id) AS walks,
            count(*) AS attempted,
            count(*) FILTER (WHERE outcome = 'canvassed') AS contacted,
            min(created_at)::VARCHAR AS first_active,
            max(created_at)::VARCHAR AS last_active
        FROM {rel}
        GROUP BY 1
        """


def canvass_days_sql(base_filters: list[str]) -> str:
    """Distinct canvass days in the display timezone, newest first.
    Binds [tz, *base_params]."""
    return f"""
        SELECT DISTINCT ((e.created_at AT TIME ZONE ?)::DATE)::VARCHAR AS day
        FROM {OPERATIONAL_PG_ALIAS}.app.canvass_events e
        JOIN {OPERATIONAL_PG_ALIAS}.app.turfs t ON t.turf_id = e.turf_id
        JOIN {OPERATIONAL_PG_ALIAS}.app.campaigns c ON c.campaign_id = t.campaign_id
        JOIN {OPERATIONAL_PG_ALIAS}.app.organizations o
            ON o.organization_id = c.organization_id
        WHERE {" AND ".join(base_filters)}
        ORDER BY day DESC
    """


def assemble_zone_rows(
    zone_rows: list[tuple[Any, ...]],
    stage_rows: list[tuple[Any, ...]],
    response_rows: list[tuple[Any, ...]],
    answered_rows: list[tuple[Any, ...]],
) -> list[dict[str, Any]]:
    """Merge the zone list with the stage, response, and answered
    aggregates: every zone gets a row (zeros when unwalked), sorted by
    name."""

    def empty_row(zone_id: str | None, zone_name: str | None) -> dict[str, Any]:
        return {
            "zoneId": zone_id,
            "zoneName": zone_name,
            "attempted": 0,
            "contacted": 0,
            "responses": {},
            "answered": {},
        }

    by_zone: dict[str | None, dict[str, Any]] = {}
    for zone_id, zone_name in zone_rows:
        by_zone[zone_id] = empty_row(zone_id, zone_name)
    for zone_id, zone_name, att, con in stage_rows:
        entry = by_zone.setdefault(zone_id, empty_row(zone_id, zone_name))
        entry.update(
            {
                # Prefer the publish-time stamp over the zone's current name.
                "zoneName": zone_name,
                "attempted": att,
                "contacted": con,
            }
        )
    for zone_id, question_id, option_id, n in response_rows:
        zone = by_zone.get(zone_id)
        if zone is None:
            continue
        zone["responses"].setdefault(question_id, {})[option_id] = n
    for zone_id, question_id, n in answered_rows:
        zone = by_zone.get(zone_id)
        if zone is None:
            continue
        zone["answered"][question_id] = n
    return sorted(by_zone.values(), key=lambda r: r["zoneName"] or "")
