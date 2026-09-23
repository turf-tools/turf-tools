"""Turf publish (src.publish_turfs): code minting, scope refusals, and the
supersede-then-insert transaction, run against an in-memory catalog
standing in for operational Postgres."""

from __future__ import annotations

import json
import uuid

import pytest
from fastapi import HTTPException

from src import publish_turfs as pt
from src.dsl.criteria import Criteria
from src.duckdb import OPERATIONAL_PG_ALIAS
from src.publish_turfs import (
    PublishTurfsRequest,
    _load_publish_scope,
    _publish,
    _PublishScope,
    _taken_turf_codes,
    mint_turf_codes,
)
from src.tables import ensure_schema, table_fqn

APP = f"{OPERATIONAL_PG_ALIAS}.app"
SCHEMA = "testds_v1"

CAMPAIGN = str(uuid.uuid4())
OTHER_CAMPAIGN = str(uuid.uuid4())
SEGMENT = str(uuid.uuid4())
SCRIPT = str(uuid.uuid4())
ZONE_GROUP = str(uuid.uuid4())
ZONE = str(uuid.uuid4())
OTHER_ZONE = str(uuid.uuid4())
USER = str(uuid.uuid4())
VERSION = str(uuid.uuid4())


# ---------------------------------------------------------------------------
# Minting
# ---------------------------------------------------------------------------


def _none_taken(_: list[str]) -> set[str]:
    return set()


def test_mint_returns_distinct_eight_digit_codes() -> None:
    codes = mint_turf_codes(20, _none_taken)
    assert len(codes) == 20
    assert len(set(codes)) == 20
    assert all(len(c) == 8 and c.isdigit() for c in codes)


def test_mint_zero_never_probes() -> None:
    calls: list[list[str]] = []

    def taken(c: list[str]) -> set[str]:
        calls.append(c)
        return set()

    assert mint_turf_codes(0, taken) == []
    assert calls == []


def test_mint_excludes_codes_the_probe_reports_taken() -> None:
    reported: set[str] = set()

    def taken(candidates: list[str]) -> set[str]:
        # Claim every other candidate is in use.
        hit = set(candidates[::2])
        reported.update(hit)
        return hit

    codes = mint_turf_codes(10, taken)
    assert len(codes) == 10
    assert not (set(codes) & reported)


def test_mint_redraws_when_a_round_comes_up_short() -> None:
    calls = 0

    def taken(candidates: list[str]) -> set[str]:
        nonlocal calls
        calls += 1
        # The first two rounds find everything taken; the third is clear.
        return set(candidates) if calls <= 2 else set()

    codes = mint_turf_codes(5, taken)
    assert len(codes) == 5
    assert calls == 3


def test_mint_gives_up_on_a_full_space() -> None:
    with pytest.raises(RuntimeError):
        mint_turf_codes(3, lambda c: set(c))


def test_probe_rejects_anything_but_digits(operational_conn) -> None:
    with pytest.raises(ValueError):
        _taken_turf_codes(operational_conn, ["1234567'"])


def test_probe_reports_existing_codes(operational_conn) -> None:
    _create_app_tables(operational_conn)
    _seed_turf(operational_conn, campaign=OTHER_CAMPAIGN, zone=None, code="11111111")
    assert _taken_turf_codes(operational_conn, ["11111111", "22222222"]) == {"11111111"}
    assert _taken_turf_codes(operational_conn, []) == set()


# ---------------------------------------------------------------------------
# Fixtures: operational tables + a tiny dataset-version schema
# ---------------------------------------------------------------------------


def _create_app_tables(conn) -> None:
    conn.execute(
        f"""CREATE TABLE {APP}.campaigns (
            campaign_id UUID, segment_id UUID, script_id UUID, zone_group_id UUID)"""
    )
    conn.execute(f"CREATE TABLE {APP}.segments (segment_id UUID, criteria VARCHAR)")
    conn.execute(f"CREATE TABLE {APP}.zone_groups (zone_group_id UUID, key_group VARCHAR)")
    conn.execute(f"CREATE TABLE {APP}.zones (zone_id UUID, zone_group_id UUID, name VARCHAR, keys VARCHAR)")
    conn.execute(
        f"""CREATE TABLE {APP}.turf_drafts (
            turf_draft_id UUID, campaign_id UUID, zone_id UUID, sort_order INT, geometry JSON)"""
    )
    conn.execute(
        f"""CREATE TABLE {APP}.turfs (
            turf_id UUID, campaign_id UUID, segment_id UUID, zone_id UUID, zone_name VARCHAR,
            zone_keys JSON, zone_group_id UUID, script_id UUID, name VARCHAR,
            turf_code VARCHAR NOT NULL UNIQUE, criteria JSON, geometry JSON,
            building_coords JSON, door_count INT, person_count INT, created_by UUID,
            dataset_version_id UUID, status VARCHAR NOT NULL DEFAULT 'active',
            created_at TIMESTAMPTZ DEFAULT now())"""
    )
    conn.execute(f"CREATE TABLE {APP}.turf_data (turf_id UUID, data JSON)")


def _square(x0: float, y0: float, size: float = 1.0) -> str:
    ring = [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]]
    return json.dumps({"type": "Polygon", "coordinates": [ring]})


def _create_voter_tables(conn) -> None:
    conn.load_extension("spatial")
    # Placeholders resolve under the DuckLake catalog name; a memory
    # catalog by that name lets the production SQL run unchanged.
    conn.execute("ATTACH ':memory:' AS ducklake")
    ensure_schema(conn, SCHEMA)
    conn.execute(
        f"""CREATE TABLE {table_fqn(SCHEMA, "persons_geocoded")} (
            external_id VARCHAR, first_name VARCHAR, last_name VARCHAR, middle_name VARCHAR,
            name_suffix VARCHAR, address_line_2 VARCHAR, building_id VARCHAR, door_id VARCHAR)"""
    )
    conn.execute(
        f"""CREATE TABLE {table_fqn(SCHEMA, "buildings_geocoded")} (
            building_id VARCHAR, latitude DOUBLE, longitude DOUBLE, address_line_1 VARCHAR,
            city VARCHAR, state VARCHAR, zip5 VARCHAR)"""
    )
    # b1 and b2 sit inside the first draft square, b3 inside the second.
    conn.execute(
        f"""INSERT INTO {table_fqn(SCHEMA, "buildings_geocoded")} VALUES
            ('b1', 0.5, 0.5, '1 Main St', 'Town', 'NY', '10001'),
            ('b2', 0.6, 0.6, '2 Main St', 'Town', 'NY', '10001'),
            ('b3', 2.5, 2.5, '3 Side St', 'Town', 'NY', '10001')"""
    )
    conn.execute(
        f"""INSERT INTO {table_fqn(SCHEMA, "persons_geocoded")} VALUES
            ('p1', 'Ann', 'A', NULL, NULL, NULL, 'b1', 'd1'),
            ('p2', 'Bob', 'B', NULL, NULL, NULL, 'b1', 'd1'),
            ('p3', 'Cat', 'C', NULL, NULL, '2', 'b2', 'd2'),
            ('p4', 'Dan', 'D', NULL, NULL, NULL, 'b3', 'd3')"""
    )


def _seed_campaign(conn, *, zoned: bool = True, segment: str | None = SEGMENT, script: str | None = SCRIPT) -> None:
    conn.execute(
        f"INSERT INTO {APP}.campaigns VALUES (?, ?, ?, ?)",
        [CAMPAIGN, segment, script, ZONE_GROUP if zoned else None],
    )
    conn.execute(f"INSERT INTO {APP}.segments VALUES (?, ?)", [SEGMENT, "{}"])
    conn.execute(f"INSERT INTO {APP}.zone_groups VALUES (?, ?)", [ZONE_GROUP, "ed"])
    conn.execute(f"INSERT INTO {APP}.zones VALUES (?, ?, ?, ?)", [ZONE, ZONE_GROUP, "Zone One", '["k1", "k2"]'])


def _seed_drafts(conn, zone: str | None, squares: list[tuple[float, float]]) -> None:
    for i, (x, y) in enumerate(squares):
        conn.execute(
            f"INSERT INTO {APP}.turf_drafts VALUES (?, ?, ?, ?, ?)",
            [str(uuid.uuid4()), CAMPAIGN, zone, i, _square(x, y)],
        )


def _seed_turf(conn, *, campaign: str, zone: str | None, code: str, status: str = "active") -> str:
    turf_id = str(uuid.uuid4())
    conn.execute(
        f"""INSERT INTO {APP}.turfs (
            turf_id, campaign_id, segment_id, zone_id, zone_group_id, script_id, name, turf_code,
            criteria, geometry, building_coords, door_count, person_count, created_by,
            dataset_version_id, status)
        VALUES (?, ?, ?, ?, ?, ?, 'Seeded', ?, '{{}}', ?, '[]', 0, 0, ?, ?, ?)""",
        [
            turf_id,
            campaign,
            SEGMENT,
            zone,
            ZONE_GROUP if zone else None,
            SCRIPT,
            code,
            _square(9, 9),
            USER,
            VERSION,
            status,
        ],
    )
    return turf_id


def _request(zone: str | None = ZONE) -> PublishTurfsRequest:
    return PublishTurfsRequest(campaignId=CAMPAIGN, zoneId=zone, createdBy=USER, orgSlug="testorg")


def _scope(zone: str | None, draft_count: int) -> _PublishScope:
    return _PublishScope(
        campaign_id=CAMPAIGN,
        segment_id=SEGMENT,
        zone_id=zone,
        zone_name="Zone One" if zone else None,
        zone_group_id=ZONE_GROUP if zone else None,
        script_id=SCRIPT,
        key_group="ed" if zone else None,
        keys=["k1", "k2"] if zone else [],
        criteria=Criteria.model_validate({}),
        draft_count=draft_count,
    )


def _run_publish(conn, zone: str | None, draft_count: int) -> dict:
    scope = _scope(zone, draft_count)
    return _publish(conn, _request(zone), scope, scope.criteria, SCHEMA, "", [], [], VERSION)


def _turf_rows(conn) -> list[tuple]:
    return conn.execute(
        f"SELECT campaign_id::VARCHAR, zone_id::VARCHAR, status, turf_code, name, door_count, person_count "
        f"FROM {APP}.turfs ORDER BY created_at, name"
    ).fetchall()


@pytest.fixture()
def conn(operational_conn):
    _create_app_tables(operational_conn)
    _create_voter_tables(operational_conn)
    return operational_conn


# ---------------------------------------------------------------------------
# Scope loading — the "not configured to publish" refusals
# ---------------------------------------------------------------------------


def test_scope_loads_zone_keys_and_draft_count(conn) -> None:
    _seed_campaign(conn)
    _seed_drafts(conn, ZONE, [(0, 0), (2, 2)])
    scope = _load_publish_scope(conn, _request())
    assert scope.zone_name == "Zone One"
    assert scope.key_group == "ed"
    assert scope.keys == ["k1", "k2"]
    assert scope.draft_count == 2


def test_scope_refuses_campaign_without_segment_or_script(conn) -> None:
    _seed_campaign(conn, script=None)
    _seed_drafts(conn, ZONE, [(0, 0)])
    with pytest.raises(HTTPException) as exc:
        _load_publish_scope(conn, _request())
    assert exc.value.status_code == 400


def test_scope_refuses_zone_for_zoneless_campaign(conn) -> None:
    _seed_campaign(conn, zoned=False)
    with pytest.raises(HTTPException) as exc:
        _load_publish_scope(conn, _request(ZONE))
    assert exc.value.status_code == 400


def test_scope_refuses_zone_outside_campaign_group(conn) -> None:
    _seed_campaign(conn)
    with pytest.raises(HTTPException) as exc:
        _load_publish_scope(conn, _request(OTHER_ZONE))
    assert exc.value.status_code == 404


def test_scope_refuses_when_no_drafts(conn) -> None:
    _seed_campaign(conn)
    with pytest.raises(HTTPException) as exc:
        _load_publish_scope(conn, _request())
    assert exc.value.status_code == 400


# ---------------------------------------------------------------------------
# The transaction: supersede, then insert
# ---------------------------------------------------------------------------


def test_first_publish_creates_one_turf_per_draft(conn) -> None:
    _seed_campaign(conn)
    _seed_drafts(conn, ZONE, [(0, 0), (2, 2)])

    result = _run_publish(conn, ZONE, 2)

    assert result["summary"] == {"turfCount": 2, "doorCount": 3, "personCount": 4, "supersededCount": 0}
    rows = _turf_rows(conn)
    assert [(r[2], r[4], r[5], r[6]) for r in rows] == [("active", "Turf 1", 2, 3), ("active", "Turf 2", 1, 1)]
    codes = [r[3] for r in rows]
    assert len(set(codes)) == 2 and all(len(c) == 8 and c.isdigit() for c in codes)
    data = conn.execute(f"SELECT data::VARCHAR FROM {APP}.turf_data").fetchall()
    assert len(data) == 2
    assert {json.loads(d[0])["turfCode"] for d in data} == set(codes)


def test_republish_supersedes_the_scope_and_keeps_codes(conn) -> None:
    _seed_campaign(conn)
    _seed_drafts(conn, ZONE, [(0, 0), (2, 2)])
    _run_publish(conn, ZONE, 2)
    first = _turf_rows(conn)

    result = _run_publish(conn, ZONE, 2)

    assert result["summary"]["supersededCount"] == 2
    rows = _turf_rows(conn)
    assert [r[2] for r in rows] == ["superseded", "superseded", "active", "active"]
    # The first generation keeps its codes; nothing is ever reminted.
    assert [r[3] for r in rows[:2]] == [r[3] for r in first]
    assert len({r[3] for r in rows}) == 4


def test_republish_leaves_other_scopes_alone(conn) -> None:
    _seed_campaign(conn)
    _seed_drafts(conn, ZONE, [(0, 0)])
    other_zone = _seed_turf(conn, campaign=CAMPAIGN, zone=OTHER_ZONE, code="00000001")
    other_campaign = _seed_turf(conn, campaign=OTHER_CAMPAIGN, zone=ZONE, code="00000002")
    in_scope = _seed_turf(conn, campaign=CAMPAIGN, zone=ZONE, code="00000003")

    result = _run_publish(conn, ZONE, 1)

    assert result["summary"]["supersededCount"] == 1
    status = dict(conn.execute(f"SELECT turf_id::VARCHAR, status FROM {APP}.turfs").fetchall())
    assert status[in_scope] == "superseded"
    assert status[other_zone] == "active"
    assert status[other_campaign] == "active"


def test_zoneless_publish_supersedes_only_zoneless_turfs(conn) -> None:
    _seed_campaign(conn, zoned=False)
    _seed_drafts(conn, None, [(0, 0)])
    zoned = _seed_turf(conn, campaign=CAMPAIGN, zone=ZONE, code="00000001")
    zoneless = _seed_turf(conn, campaign=CAMPAIGN, zone=None, code="00000002")

    result = _run_publish(conn, None, 1)

    assert result["summary"]["supersededCount"] == 1
    status = dict(conn.execute(f"SELECT turf_id::VARCHAR, status FROM {APP}.turfs").fetchall())
    assert status[zoneless] == "superseded"
    assert status[zoned] == "active"
    new = conn.execute(
        f"SELECT zone_id, zone_name FROM {APP}.turfs WHERE status = 'active' AND name = 'Turf 1'"
    ).fetchone()
    assert new == (None, None)


def test_code_race_is_retried_with_fresh_codes(conn, monkeypatch) -> None:
    """A concurrent publish landing the same code between probe and insert
    trips the unique index; the retry redraws and replays the whole
    transaction, so the failed attempt leaves nothing behind."""
    _seed_campaign(conn)
    _seed_drafts(conn, ZONE, [(0, 0), (2, 2)])
    _seed_turf(conn, campaign=OTHER_CAMPAIGN, zone=None, code="55555555")
    draws: list[list[str]] = [["55555555", "00000009"], ["12345678", "87654321"]]

    def fake_mint(count: int, taken) -> list[str]:
        assert count == 2
        return draws.pop(0)

    monkeypatch.setattr(pt, "mint_turf_codes", fake_mint)

    result = _run_publish(conn, ZONE, 2)

    assert draws == []
    assert result["summary"]["turfCount"] == 2
    rows = _turf_rows(conn)
    assert len(rows) == 3
    assert sorted(r[3] for r in rows if r[2] == "active") == ["12345678", "55555555", "87654321"]


def test_failed_publish_leaves_prior_generation_active(conn) -> None:
    _seed_campaign(conn)
    _seed_drafts(conn, ZONE, [(0, 0)])
    prior = _seed_turf(conn, campaign=CAMPAIGN, zone=ZONE, code="00000001")
    # Break the second insert so the transaction fails after superseding.
    conn.execute(f"DROP TABLE {APP}.turf_data")

    with pytest.raises(Exception, match="turf_data"):
        _run_publish(conn, ZONE, 1)

    rows = conn.execute(f"SELECT turf_id::VARCHAR, status FROM {APP}.turfs").fetchall()
    assert rows == [(prior, "active")]
