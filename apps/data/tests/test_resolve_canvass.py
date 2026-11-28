"""Canvass-filter resolution against a synthetic operational catalog."""

from __future__ import annotations

import json
from datetime import UTC, datetime

from src.dsl.resolve import _canvass_outcome_person_ids, _canvass_response_person_ids
from src.duckdb import OPERATIONAL_PG_ALIAS

APP = f"{OPERATIONAL_PG_ALIAS}.app"


def _payload(outcome: str | None = "canvassed", **responses: list[str]) -> str:
    body: dict = {
        "kind": "result",
        "outcome": outcome,
        "responses": {q: {"optionIds": opts} for q, opts in responses.items()},
    }
    return json.dumps(body)


def _seed_org_and_events(conn) -> None:
    conn.execute(f"CREATE TABLE {APP}.organizations (organization_id VARCHAR, slug VARCHAR)")
    conn.execute(f"CREATE TABLE {APP}.campaigns (campaign_id VARCHAR, organization_id VARCHAR)")
    conn.execute(
        f"""CREATE TABLE {APP}.turfs (
            turf_id VARCHAR, campaign_id VARCHAR, status VARCHAR)"""
    )
    conn.execute(
        f"""CREATE TABLE {APP}.canvass_events (
            kind VARCHAR, person_id VARCHAR, turf_id VARCHAR,
            sequence BIGINT, payload VARCHAR)"""
    )
    conn.execute(
        f"""CREATE TABLE {APP}.imported_responses (
            organization_id VARCHAR,
            person_id VARCHAR,
            question_id VARCHAR,
            response_option_id VARCHAR,
            responded_at TIMESTAMP)"""
    )
    conn.execute(f"INSERT INTO {APP}.organizations VALUES ('org1', 'testorg')")
    conn.execute(f"INSERT INTO {APP}.campaigns VALUES ('camp1', 'org1')")
    conn.execute(
        f"""INSERT INTO {APP}.turfs VALUES
            ('turf-old', 'camp1', 'superseded'),
            ('turf-new', 'camp1', 'active')"""
    )


def _seed_recut_with_changed_answer(conn) -> None:
    """Person answered yes on the old turf; after re-cut they answered no
    on the new turf (higher sequence)."""
    _seed_org_and_events(conn)
    conn.executemany(
        f"INSERT INTO {APP}.canvass_events VALUES ('result', ?, ?, ?, ?)",
        [
            ("p1", "turf-old", 1, _payload("canvassed", q_support=["yes"])),
            ("p1", "turf-new", 2, _payload("not_home", q_support=["no"])),
        ],
    )


def test_field_outcome_is_existential_across_turfs(operational_conn) -> None:
    """v1 outcome path keeps latest per (turf, person), then ORs across turfs."""
    _seed_recut_with_changed_answer(operational_conn)

    canvassed = _canvass_outcome_person_ids(operational_conn, "testorg", ["canvassed"])
    not_home = _canvass_outcome_person_ids(operational_conn, "testorg", ["not_home"])

    assert canvassed == ["p1"]
    assert not_home == ["p1"]


def test_field_response_is_existential_across_turfs(operational_conn) -> None:
    """v1 field path keeps latest per (turf, person), then ORs across turfs."""
    _seed_recut_with_changed_answer(operational_conn)

    yes_ids = _canvass_response_person_ids(operational_conn, "testorg", "q_support", ["yes"])
    no_ids = _canvass_response_person_ids(operational_conn, "testorg", "q_support", ["no"])

    assert sorted(yes_ids) == ["p1"]
    assert sorted(no_ids) == ["p1"]


def test_imported_response_only(operational_conn) -> None:
    _seed_org_and_events(operational_conn)
    day = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    operational_conn.execute(
        f"""INSERT INTO {APP}.imported_responses VALUES
            ('org1', 'p_import', 'q_support', 'yes', ?)""",
        [day],
    )

    yes_ids = _canvass_response_person_ids(operational_conn, "testorg", "q_support", ["yes"])
    no_ids = _canvass_response_person_ids(operational_conn, "testorg", "q_support", ["no"])

    assert yes_ids == ["p_import"]
    assert no_ids == []


def test_imported_response_uses_latest_day(operational_conn) -> None:
    _seed_org_and_events(operational_conn)
    older = datetime(2026, 5, 1, 12, 0, tzinfo=UTC)
    newer = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)
    operational_conn.executemany(
        f"INSERT INTO {APP}.imported_responses VALUES ('org1', 'p1', 'q_support', ?, ?)",
        [("yes", older), ("no", newer)],
    )

    yes_ids = _canvass_response_person_ids(operational_conn, "testorg", "q_support", ["yes"])
    no_ids = _canvass_response_person_ids(operational_conn, "testorg", "q_support", ["no"])

    assert yes_ids == []
    assert no_ids == ["p1"]


def test_field_and_import_union(operational_conn) -> None:
    _seed_org_and_events(operational_conn)
    operational_conn.execute(
        f"INSERT INTO {APP}.canvass_events VALUES ('result', ?, ?, ?, ?)",
        ["p_field", "turf-new", 1, _payload("canvassed", q_support=["yes"])],
    )
    day = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    operational_conn.execute(
        f"""INSERT INTO {APP}.imported_responses VALUES
            ('org1', 'p_import', 'q_support', 'yes', ?)""",
        [day],
    )

    yes_ids = _canvass_response_person_ids(operational_conn, "testorg", "q_support", ["yes"])
    assert sorted(yes_ids) == ["p_field", "p_import"]


def test_field_match_does_not_erase_import_match(operational_conn) -> None:
    """A newer field 'no' still leaves an imported 'yes' matching (union)."""
    _seed_org_and_events(operational_conn)
    operational_conn.execute(
        f"INSERT INTO {APP}.canvass_events VALUES ('result', ?, ?, ?, ?)",
        ["p1", "turf-new", 2, _payload("canvassed", q_support=["no"])],
    )
    day = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    operational_conn.execute(
        f"""INSERT INTO {APP}.imported_responses VALUES
            ('org1', 'p1', 'q_support', 'yes', ?)""",
        [day],
    )

    yes_ids = _canvass_response_person_ids(operational_conn, "testorg", "q_support", ["yes"])
    no_ids = _canvass_response_person_ids(operational_conn, "testorg", "q_support", ["no"])

    assert yes_ids == ["p1"]
    assert no_ids == ["p1"]
