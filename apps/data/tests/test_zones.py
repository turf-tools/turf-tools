"""Zone helpers (src.zones): key flattening, per-zone target counts,
and perimeter sealing."""

from __future__ import annotations

import json

import duckdb
from src.zones import (
    boundary_key_counts,
    flatten_zone_keys,
    perimeter_union_sql,
    zone_perimeter_geojson,
    zone_target_counts_sql,
)


def test_flatten_zone_keys_pairs_ids_with_keys() -> None:
    assert flatten_zone_keys([("z1", ["a", "b"]), ("z2", ["c"]), ("z3", [])]) == (
        ["z1", "z1", "z2"],
        ["a", "b", "c"],
    )


def _persons_conn() -> duckdb.DuckDBPyConnection:
    c = duckdb.connect()
    c.execute("CREATE TABLE persons (external_id VARCHAR, ed_key VARCHAR, door_i BIGINT, age INT)")
    c.executemany(
        "INSERT INTO persons VALUES (?, ?, ?, ?)",
        [
            ("p1", "k1", 1, 30),
            ("p2", "k1", 1, 72),
            ("p3", "k1", 2, 40),
            ("p4", "k2", 3, 25),
            # k9 belongs to no zone in the tests below.
            ("p5", "k9", 9, 50),
        ],
    )
    return c


def test_zone_target_counts_people_and_doors() -> None:
    conn = _persons_conn()
    zone_ids, keys = flatten_zone_keys([("z1", ["k1"]), ("z2", ["k2"])])
    rows = conn.execute(zone_target_counts_sql("persons", "ed_key", ""), [zone_ids, keys]).fetchall()
    # p1 and p2 share a door in z1; k9 maps to no zone and drops out.
    assert {z: (people, doors) for z, people, doors in rows} == {"z1": (3, 2), "z2": (1, 1)}


def test_zone_target_counts_apply_criteria_where() -> None:
    conn = _persons_conn()
    zone_ids, keys = flatten_zone_keys([("z1", ["k1"]), ("z2", ["k2"])])
    rows = conn.execute(zone_target_counts_sql("persons", "ed_key", "WHERE age >= ?"), [zone_ids, keys, 40]).fetchall()
    # z2's only person is under 40 — no row, not a zero row.
    assert {z: (people, doors) for z, people, doors in rows} == {"z1": (2, 2)}


def _boundaries_conn() -> duckdb.DuckDBPyConnection:
    c = duckdb.connect()
    c.install_extension("spatial")
    c.load_extension("spatial")
    c.execute("CREATE TABLE boundaries (key VARCHAR, geom GEOMETRY)")
    # Two squares separated by a gap narrower than the seed-time
    # simplification tolerance — the artifact the closing exists to seal.
    c.execute(
        """INSERT INTO boundaries VALUES
        ('a', ST_GeomFromText('POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))')),
        ('b', ST_GeomFromText('POLYGON((1.00005 0, 2 0, 2 1, 1.00005 1, 1.00005 0))'))"""
    )
    return c


def test_perimeter_union_seals_sliver_gaps() -> None:
    c = _boundaries_conn()
    # Control: the plain union keeps the crack — two disjoint polygons.
    plain = c.execute("SELECT ST_GeometryType(ST_Union_Agg(ST_MakeValid(geom))) FROM boundaries").fetchone()
    assert plain is not None and plain[0] == "MULTIPOLYGON"
    row = c.execute(perimeter_union_sql("boundaries"), [["a", "b"]]).fetchone()
    assert row is not None
    sealed = json.loads(row[0])
    assert sealed["type"] == "Polygon"


def test_boundary_key_counts_orders_granularity_and_drops_unseeded() -> None:
    c = duckdb.connect()
    c.execute("CREATE TABLE eds (key VARCHAR)")
    c.execute("INSERT INTO eds VALUES ('a'), ('b'), ('c')")
    c.execute("CREATE TABLE zips (key VARCHAR)")
    c.execute("INSERT INTO zips VALUES ('z')")
    counts = boundary_key_counts(c, {"eds": "eds", "zips": "zips", "blocks": "missing"})
    assert counts == {"eds": 3, "zips": 1}
    assert max(counts, key=lambda kg: counts[kg]) == "eds"


def test_zone_perimeter_geojson_memoizes_across_connections() -> None:
    zone_perimeter_geojson.cache_clear()
    first = zone_perimeter_geojson(_boundaries_conn(), "boundaries", ("a", "b"))
    assert first is not None and json.loads(first)["type"] == "Polygon"
    # A connection with no boundaries table proves the hit runs no SQL.
    bare = duckdb.connect()
    assert zone_perimeter_geojson(bare, "boundaries", ("a", "b")) == first
