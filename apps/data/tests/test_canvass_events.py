"""The canvass-event reduction (src.canvass_events): production SQL run
verbatim against a synthetic in-memory operational catalog.

The seeded story exercises the pinned semantics: latest result per
person by sequence (supersession), cross-campaign supersession when no
campaign scope is given, date-window = reduce-to-latest *within* the
window, responses counted only among the contacted, population join
over the criteria WHERE, and timezone-correct day bucketing.
"""

from __future__ import annotations

import json

from src.canvass_events import (
    assemble_zone_rows,
    canvass_days_sql,
    event_scope,
    latest_results_cte,
    responses_sql,
    stages_sql,
)
from src.duckdb import OPERATIONAL_PG_ALIAS

APP = f"{OPERATIONAL_PG_ALIAS}.app"

# Aug 23 and Aug 24, 2026 in America/New_York (UTC-4).
DAY1_NOON = "2026-08-23 16:00:00+00"
DAY1_LATE = "2026-08-24 03:30:00+00"  # Aug 23, 23:30 ET — day 1, not day 2
DAY2_NOON = "2026-08-24 16:00:00+00"
TZ = "America/New_York"


def _payload(outcome: str | None, **responses: list[str]) -> str:
    body: dict = {"responses": {q: {"optionIds": opts} for q, opts in responses.items()}}
    if outcome is not None:
        body["outcome"] = outcome
    return json.dumps(body)


def _seed(conn) -> None:
    conn.execute(f"CREATE TABLE {APP}.organizations (organization_id VARCHAR, slug VARCHAR)")
    conn.execute(f"CREATE TABLE {APP}.campaigns (campaign_id VARCHAR, organization_id VARCHAR)")
    conn.execute(f"CREATE TABLE {APP}.turfs (turf_id VARCHAR, campaign_id VARCHAR, zone_id VARCHAR, zone_name VARCHAR)")
    conn.execute(
        f"""CREATE TABLE {APP}.canvass_events (
            kind VARCHAR, person_id VARCHAR, turf_id VARCHAR,
            sequence BIGINT, created_at TIMESTAMPTZ, payload VARCHAR)"""
    )
    conn.execute("CREATE TABLE persons (external_id VARCHAR)")

    conn.execute(f"INSERT INTO {APP}.organizations VALUES ('org1', 'testorg')")
    conn.execute(f"INSERT INTO {APP}.campaigns VALUES ('camp1', 'org1'), ('camp2', 'org1')")
    conn.execute(
        f"""INSERT INTO {APP}.turfs VALUES
            ('turf1', 'camp1', 'z1', 'Zone One'),
            ('turf2', 'camp1', 'z2', 'Zone Two'),
            ('turf3', 'camp2', 'z9', 'Zone Nine')"""
    )
    events = [
        # p1: canvassed then superseded by not_home on the same day.
        ("p1", "turf1", 1, DAY1_NOON, _payload("canvassed", q1=["yes"])),
        ("p1", "turf1", 2, DAY1_NOON, _payload("not_home")),
        # p2: canvassed in camp1, later not_home in camp2 (cross-campaign
        # supersession when no campaign scope is given).
        ("p2", "turf1", 3, DAY1_NOON, _payload("canvassed", q1=["no"], q2=["a", "b"])),
        ("p2", "turf3", 10, DAY2_NOON, _payload("not_home")),
        # p3: canvassed day 1, cleared day 2.
        ("p3", "turf1", 4, DAY1_NOON, _payload("canvassed", q1=["yes"])),
        ("p3", "turf1", 11, DAY2_NOON, _payload(None)),
        # p4: the only touch on zone 2.
        ("p4", "turf2", 6, DAY2_NOON, _payload("not_home")),
        # p5: late-evening ET event that lands on day 1, not day 2.
        ("p5", "turf1", 7, DAY1_LATE, _payload("canvassed")),
        # p6: has an event but is not in the population table.
        ("p6", "turf1", 8, DAY1_NOON, _payload("canvassed")),
    ]
    conn.executemany(f"INSERT INTO {APP}.canvass_events VALUES ('result', ?, ?, ?, ?, ?)", events)
    conn.executemany("INSERT INTO persons VALUES (?)", [["p1"], ["p2"], ["p3"], ["p4"], ["p5"]])


def _stages(conn, scope, where: str = "", where_params: list | None = None) -> dict:
    cte = latest_results_cte("persons", where, scope.event_filters)
    rows = conn.execute(stages_sql(cte), [*scope.event_params, *(where_params or [])]).fetchall()
    return {zone_id: (att, con) for zone_id, _name, att, con in rows}


def _responses(conn, scope) -> dict:
    cte = latest_results_cte("persons", "", scope.event_filters)
    rows = conn.execute(responses_sql(cte), scope.event_params).fetchall()
    out: dict = {}
    for zone_id, question_id, option_id, n in rows:
        out.setdefault(zone_id, {}).setdefault(question_id, {})[option_id] = n
    return out


def test_latest_result_per_person_wins(operational_conn) -> None:
    _seed(operational_conn)
    stages = _stages(operational_conn, event_scope("testorg", ["camp1"]))
    # z1: p1 not_home (canvassed superseded), p2 canvassed, p3 cleared
    # (attempted in neither count), p5 canvassed; p6 not in persons.
    assert stages == {"z1": (3, 2), "z2": (1, 0)}


def test_cross_campaign_supersession_without_scope(operational_conn) -> None:
    _seed(operational_conn)
    stages = _stages(operational_conn, event_scope("testorg", None))
    # p2's camp2 not_home outranks the camp1 canvassed, moving the person
    # to zone 9 — the reduction is per person, not per campaign.
    assert stages == {"z1": (2, 1), "z2": (1, 0), "z9": (1, 0)}


def test_day_window_reduces_within_window(operational_conn) -> None:
    _seed(operational_conn)
    scope = event_scope("testorg", ["camp1"], day="2026-08-23", tz=TZ)
    # p3's day-2 clear is outside the window, so day 1 still shows the
    # canvass; p5's 23:30 ET event belongs to day 1.
    assert _stages(operational_conn, scope) == {"z1": (4, 3)}
    responses = _responses(operational_conn, scope)
    assert responses == {"z1": {"q1": {"yes": 1, "no": 1}, "q2": {"a": 1, "b": 1}}}


def test_responses_only_among_contacted(operational_conn) -> None:
    _seed(operational_conn)
    responses = _responses(operational_conn, event_scope("testorg", ["camp1"]))
    # p1's "yes" is gone with the superseding not_home; p3's with the
    # clear. Only p2's answers remain, both q2 options counted.
    assert responses == {"z1": {"q1": {"no": 1}, "q2": {"a": 1, "b": 1}}}


def test_population_where_narrows_the_join(operational_conn) -> None:
    _seed(operational_conn)
    scope = event_scope("testorg", ["camp1"])
    stages = _stages(operational_conn, scope, "WHERE external_id = ?", ["p2"])
    assert stages == {"z1": (1, 1)}


def test_canvass_days_bucket_in_display_timezone(operational_conn) -> None:
    _seed(operational_conn)
    # Day list rides the base filters only — a date filter must not
    # collapse the picker's options.
    scope = event_scope("testorg", ["camp1"], day="2026-08-23", tz=TZ)
    rows = operational_conn.execute(canvass_days_sql(scope.base_filters), [TZ, *scope.base_params]).fetchall()
    assert [r[0] for r in rows] == ["2026-08-24", "2026-08-23"]


def test_assemble_zone_rows_zero_fills_and_keeps_publish_names() -> None:
    zone_rows = [("z1", "Zone One RENAMED"), ("z2", "Zone Two"), ("z3", "Zone Three")]
    stage_rows = [("z1", "Zone One", 3, 2)]
    response_rows = [("z1", "q1", "no", 1), ("zX", "q1", "no", 9)]
    rows = assemble_zone_rows(zone_rows, stage_rows, response_rows)
    assert [r["zoneName"] for r in rows] == ["Zone One", "Zone Three", "Zone Two"]
    walked = rows[0]
    # The publish-time stamp wins over the zone's current name.
    assert walked == {
        "zoneId": "z1",
        "zoneName": "Zone One",
        "attempted": 3,
        "contacted": 2,
        "responses": {"q1": {"no": 1}},
    }
    assert all(r["attempted"] == 0 and r["responses"] == {} for r in rows[1:])
