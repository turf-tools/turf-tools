"""The canvass-event reduction (src.canvass_events): production SQL run
verbatim against a synthetic in-memory operational catalog.

The seeded story exercises the pinned semantics: latest result per
person by sequence (supersession), cross-campaign supersession when no
campaign scope is given, date-window = reduce-to-latest *within* the
window, responses counted only among the contacted, population join
over the criteria WHERE, and timezone-correct day bucketing. The
attempt grain adds: latest per (person, walk), day-bucket fallback for
walkless events, and clear-erasure of a person's attempt history.
"""

from __future__ import annotations

import json

from src.canvass_events import (
    answered_sql,
    assemble_zone_rows,
    attempts_cte,
    canvass_days_sql,
    canvasser_stats_sql,
    event_scope,
    latest_results_cte,
    responses_sql,
    stages_sql,
    walk_stats_sql,
)
from src.duckdb import OPERATIONAL_PG_ALIAS, materialize

APP = f"{OPERATIONAL_PG_ALIAS}.app"

# Aug 23 and Aug 24, 2026 in America/New_York (UTC-4).
DAY1_NOON = "2026-08-23 16:00:00+00"
DAY1_LATE = "2026-08-24 03:30:00+00"  # Aug 23, 23:30 ET — day 1, not day 2
DAY2_NOON = "2026-08-24 16:00:00+00"
TZ = "America/New_York"


def _payload(outcome: str | None, **responses: list[str] | str) -> str:
    # A string answer is open-ended text; a list is option picks.
    def encode(v: list[str] | str) -> dict:
        return {"text": v} if isinstance(v, str) else {"optionIds": v}

    body: dict = {"responses": {q: encode(v) for q, v in responses.items()}}
    if outcome is not None:
        body["outcome"] = outcome
    return json.dumps(body)


def _seed(conn) -> None:
    conn.execute(f"CREATE TABLE {APP}.organizations (organization_id VARCHAR, slug VARCHAR)")
    conn.execute(f"CREATE TABLE {APP}.campaigns (campaign_id VARCHAR, organization_id VARCHAR, name VARCHAR)")
    conn.execute(
        f"""CREATE TABLE {APP}.turfs (
            turf_id VARCHAR, campaign_id VARCHAR, zone_id VARCHAR, zone_name VARCHAR,
            name VARCHAR, turf_code VARCHAR, person_count INT, door_count INT)"""
    )
    conn.execute(
        f"""CREATE TABLE {APP}.canvass_events (
            kind VARCHAR, person_id VARCHAR, turf_id VARCHAR, walk_id VARCHAR,
            canvasser_name VARCHAR, canvasser_phone VARCHAR,
            sequence BIGINT, created_at TIMESTAMPTZ, payload VARCHAR)"""
    )
    conn.execute("CREATE TABLE persons (external_id VARCHAR)")

    conn.execute(f"INSERT INTO {APP}.organizations VALUES ('org1', 'testorg')")
    conn.execute(f"INSERT INTO {APP}.campaigns VALUES ('camp1', 'org1', 'Camp One'), ('camp2', 'org1', 'Camp Two')")
    conn.execute(
        f"""INSERT INTO {APP}.turfs VALUES
            ('turf1', 'camp1', 'z1', 'Zone One', 'Turf One', 'T1', 10, 5),
            ('turf2', 'camp1', 'z2', 'Zone Two', 'Turf Two', 'T2', 8, 4),
            ('turf3', 'camp2', 'z9', 'Zone Nine', 'Turf Nine', 'T9', 6, 3)"""
    )
    events = [
        # p1: canvassed then superseded by not_home on the same day (and
        # the same walk — one attempt).
        ("p1", "turf1", "w1", "Jer", "+1", 1, DAY1_NOON, _payload("canvassed", q1=["yes"])),
        ("p1", "turf1", "w1", "Jer", "+1", 2, DAY1_NOON, _payload("not_home")),
        # p2: canvassed in camp1, later not_home in camp2 (cross-campaign
        # supersession when no campaign scope is given).
        ("p2", "turf1", "w1", "Jer", "+1", 3, DAY1_NOON, _payload("canvassed", q1=["no"], q2=["a", "b"], qt="Julian")),
        ("p2", "turf3", "w9", "Os", "+2", 10, DAY2_NOON, _payload("not_home")),
        # p3: canvassed day 1, cleared day 2.
        ("p3", "turf1", "w1", "Jer", "+1", 4, DAY1_NOON, _payload("canvassed", q1=["yes"])),
        ("p3", "turf1", "w3", "Os", "+2", 11, DAY2_NOON, _payload(None)),
        # p4: the only touch on zone 2.
        ("p4", "turf2", "w2", "Os", "+2", 6, DAY2_NOON, _payload("not_home")),
        # p5: late-evening ET event that lands on day 1, not day 2; its
        # empty text answer is not an answer.
        ("p5", "turf1", "w1", "Jer", "+1", 7, DAY1_LATE, _payload("canvassed", qt="")),
        # p6: has an event but is not in the population table.
        ("p6", "turf1", "w1", "Jer", "+1", 8, DAY1_NOON, _payload("canvassed")),
    ]
    conn.executemany(f"INSERT INTO {APP}.canvass_events VALUES ('result', ?, ?, ?, ?, ?, ?, ?, ?)", events)
    conn.executemany("INSERT INTO persons VALUES (?)", [["p1"], ["p2"], ["p3"], ["p4"], ["p5"]])


def _seed_attempt_extras(conn) -> None:
    """People exercising attempt-grain cases the base story doesn't:
    two walks in one day, and pre-stamp events with no walk_id."""
    events = [
        # p7: knocked on two walks the same day — two attempts (the walk
        # partition must beat day bucketing).
        ("p7", "turf1", "wA", "Jer", "+1", 20, DAY1_NOON, _payload("not_home")),
        ("p7", "turf1", "wB", "Os", "+2", 21, DAY1_NOON, _payload("canvassed", q1=["yes"])),
        # p8: pre-stamp client (walk_id NULL) — falls back to day
        # grouping: two day-1 events collapse, day 2 is a second attempt.
        ("p8", "turf1", None, "Jer", "+1", 22, DAY1_NOON, _payload("not_home")),
        ("p8", "turf1", None, "Jer", "+1", 23, DAY1_NOON, _payload("not_home")),
        ("p8", "turf1", None, "Jer", "+1", 24, DAY2_NOON, _payload("canvassed")),
    ]
    conn.executemany(f"INSERT INTO {APP}.canvass_events VALUES ('result', ?, ?, ?, ?, ?, ?, ?, ?)", events)
    conn.executemany("INSERT INTO persons VALUES (?)", [["p7"], ["p8"]])


def _materialize_joined(conn, scope, where: str = "", where_params: list | None = None) -> str:
    """The production shape: reduce once into a temp table, aggregate from it."""
    return materialize(
        conn,
        "joined",
        latest_results_cte("persons", where, scope.event_filters) + "SELECT * FROM joined",
        [*scope.event_params, *(where_params or [])],
    )


def _materialize_attempts(conn, scope) -> str:
    return materialize(
        conn,
        "attempts",
        attempts_cte("persons", "", scope.event_filters) + "SELECT * FROM attempts",
        [*scope.event_params, TZ],
    )


def _stages(conn, scope, where: str = "", where_params: list | None = None) -> dict:
    joined = _materialize_joined(conn, scope, where, where_params)
    rows = conn.execute(stages_sql(joined)).fetchall()
    return {zone_id: (att, con) for zone_id, _name, att, con in rows}


def _responses(conn, scope) -> dict:
    joined = _materialize_joined(conn, scope)
    rows = conn.execute(responses_sql(joined)).fetchall()
    out: dict = {}
    for zone_id, question_id, option_id, n in rows:
        out.setdefault(zone_id, {}).setdefault(question_id, {})[option_id] = n
    return out


def _attempts(conn, scope, where: str = "", where_params: list | None = None) -> dict:
    rows = conn.execute(
        attempts_cte("persons", where, scope.event_filters)
        + "SELECT person_id, walk_id, outcome FROM attempts ORDER BY person_id, sequence",
        [*scope.event_params, TZ, *(where_params or [])],
    ).fetchall()
    out: dict = {}
    for person_id, walk_id, outcome in rows:
        out.setdefault(person_id, []).append((walk_id, outcome))
    return out


def test_walk_stats_group_the_attempt_grain(operational_conn) -> None:
    _seed(operational_conn)
    _seed_attempt_extras(operational_conn)
    scope = event_scope("testorg", ["camp1"])
    rel = _materialize_attempts(operational_conn, scope)
    rows = operational_conn.execute(walk_stats_sql(rel)).fetchall()
    stats = {walk_id: (att, con) for walk_id, att, con, _first, _last in rows}
    # p8's walkless attempts have no walk to attribute to; p3's history
    # is clear-erased before it can count toward w1.
    assert stats == {"w1": (3, 2), "w2": (1, 0), "wA": (1, 0), "wB": (1, 1)}


def test_canvasser_stats_derive_from_attempts(operational_conn) -> None:
    _seed(operational_conn)
    _seed_attempt_extras(operational_conn)
    scope = event_scope("testorg", ["camp1"])
    rel = _materialize_attempts(operational_conn, scope)
    rows = operational_conn.execute(canvasser_stats_sql(rel)).fetchall()
    stats = {key: (name, walks, att, con) for key, name, _phone, walks, att, con, _first, _last in rows}
    # Walkless attempts still count as attempts but not as walks; the
    # identity key is the claimed phone.
    assert stats == {
        "+1": ("Jer", 2, 6, 3),
        "+2": ("Os", 2, 2, 1),
    }


def test_attempts_latest_per_person_walk(operational_conn) -> None:
    _seed(operational_conn)
    _seed_attempt_extras(operational_conn)
    attempts = _attempts(operational_conn, event_scope("testorg", ["camp1"]))
    assert attempts == {
        # Same-walk supersession collapses to one attempt, latest wins.
        "p1": [("w1", "not_home")],
        "p2": [("w1", "canvassed")],
        # p3's later clear erases the attempt history entirely.
        "p4": [("w2", "not_home")],
        "p5": [("w1", "canvassed")],
        # Two walks the same day are two attempts.
        "p7": [("wA", "not_home"), ("wB", "canvassed")],
        # No walk_id: day bucketing — day 1's pair collapses, day 2 is new.
        "p8": [(None, "not_home"), (None, "canvassed")],
        # p6 has events but is not in the population.
    }


def test_attempts_day_scope_is_relative(operational_conn) -> None:
    _seed(operational_conn)
    _seed_attempt_extras(operational_conn)
    scope = event_scope("testorg", ["camp1"], day="2026-08-23", tz=TZ)
    attempts = _attempts(operational_conn, scope)
    # p3's day-2 clear is outside the window, so day 1 keeps the attempt;
    # p4 and p8's second attempt are day 2; p5's 23:30 ET is day 1.
    assert attempts == {
        "p1": [("w1", "not_home")],
        "p2": [("w1", "canvassed")],
        "p3": [("w1", "canvassed")],
        "p5": [("w1", "canvassed")],
        "p7": [("wA", "not_home"), ("wB", "canvassed")],
        "p8": [(None, "not_home")],
    }


def test_attempts_population_where_narrows_the_join(operational_conn) -> None:
    _seed(operational_conn)
    _seed_attempt_extras(operational_conn)
    scope = event_scope("testorg", ["camp1"])
    attempts = _attempts(operational_conn, scope, "WHERE external_id = ?", ["p7"])
    assert attempts == {"p7": [("wA", "not_home"), ("wB", "canvassed")]}


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


def test_answered_counts_any_content(operational_conn) -> None:
    _seed(operational_conn)
    scope = event_scope("testorg", ["camp1"])
    joined = _materialize_joined(operational_conn, scope)
    rows = operational_conn.execute(answered_sql(joined)).fetchall()
    answered: dict = {}
    for zone_id, question_id, n in rows:
        answered.setdefault(zone_id, {})[question_id] = n
    # Option picks and non-empty text both count as answered; p5's empty
    # text does not, and superseded/cleared answers are gone with their
    # events.
    assert answered == {"z1": {"q1": 1, "q2": 1, "qt": 1}}


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
    answered_rows = [("z1", "qt", 2), ("zX", "qt", 9)]
    rows = assemble_zone_rows(zone_rows, stage_rows, response_rows, answered_rows)
    assert [r["zoneName"] for r in rows] == ["Zone One", "Zone Three", "Zone Two"]
    walked = rows[0]
    # The publish-time stamp wins over the zone's current name.
    assert walked == {
        "zoneId": "z1",
        "zoneName": "Zone One",
        "attempted": 3,
        "contacted": 2,
        "responses": {"q1": {"no": 1}},
        "answered": {"qt": 2},
    }
    assert all(r["attempted"] == 0 and r["responses"] == {} for r in rows[1:])
