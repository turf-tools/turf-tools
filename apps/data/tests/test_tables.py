"""Tests for `src.tables`: placeholder substitution and post-import pruning."""

import pytest

from src.importers.fl_voter_file.manifest import FL_MANIFEST
from src.tables import (
    QUERYABLE_TABLES,
    UnknownAbstractTableError,
    drop_intermediates,
    reclaim_dropped_files,
    resolve,
    retained_tables,
    table_fqn,
)


def test_resolves_a_known_placeholder() -> None:
    sql = "SELECT count(*) FROM {persons_geocoded}"
    assert resolve(sql, schema="default") == "SELECT count(*) FROM ducklake.default.persons_geocoded"


def test_resolves_multiple_placeholders_in_one_query() -> None:
    sql = "SELECT * FROM {persons_geocoded} p JOIN {buildings_geocoded} b ON b.building_id = p.building_id"
    out = resolve(sql, schema="acme")
    assert "ducklake.acme.persons_geocoded" in out
    assert "ducklake.acme.buildings_geocoded" in out
    assert "{" not in out


def test_resolves_repeated_placeholder() -> None:
    sql = "SELECT * FROM {persons_geocoded} UNION SELECT * FROM {persons_geocoded}"
    out = resolve(sql, schema="default")
    assert out.count("ducklake.default.persons_geocoded") == 2


def test_passes_through_sql_with_no_placeholders() -> None:
    sql = "SELECT 1"
    assert resolve(sql, schema="default") == "SELECT 1"


def test_raises_on_unknown_placeholder() -> None:
    sql = "SELECT * FROM {persons_typoed}"
    with pytest.raises(UnknownAbstractTableError):
        resolve(sql, schema="default")


def test_does_not_match_unrelated_braces() -> None:
    # `{}` patterns that aren't valid placeholder names (e.g. JSON
    # literals embedded in SQL strings) should pass through. Our regex
    # anchors on `[a-z_]+`, so digits, uppercase, mixed punctuation
    # don't match.
    sql = "SELECT '{nope: 1}', '{ABC}', '{123}', count(*) FROM {persons_geocoded}"
    out = resolve(sql, schema="x")
    assert "ducklake.x.persons_geocoded" in out
    assert "{nope: 1}" in out
    assert "{ABC}" in out
    assert "{123}" in out


def test_table_fqn_leaves_plain_slugs_unquoted() -> None:
    # Plain identifier slugs read more naturally without quotes.
    assert table_fqn("default", "persons_geocoded") == "ducklake.default.persons_geocoded"
    assert table_fqn("nyc_dsa", "persons_geocoded") == "ducklake.nyc_dsa.persons_geocoded"


def test_table_fqn_quotes_hyphenated_slugs() -> None:
    # Slugs with hyphens (`test-org`) must round-trip through SQL
    # without being interpreted as an operator.
    assert table_fqn("test-org", "persons_geocoded") == 'ducklake."test-org".persons_geocoded'


def test_table_fqn_escapes_embedded_quotes() -> None:
    # Defense in depth: a slug containing a double-quote shouldn't
    # break out of the identifier. Slugs shouldn't have this in
    # practice (org-creation should validate) but the helper handles
    # it correctly if one slips through.
    assert table_fqn('weird"slug', "persons_geocoded") == 'ducklake."weird""slug".persons_geocoded'


def test_retained_tables_keeps_queryable_key_group_and_record_tables() -> None:
    keep = retained_tables(FL_MANIFEST)
    assert keep >= QUERYABLE_TABLES
    assert {"fl_zips", "fl_precincts", "elections", "geocoding_summary"} <= keep
    assert "persons_raw" not in keep
    assert "persons_scored" not in keep


def _tables(conn, schema: str) -> set[str]:
    rows = conn.execute(
        "SELECT table_name FROM duckdb_tables() WHERE database_name = 'ducklake' AND schema_name = ?", [schema]
    ).fetchall()
    return {name for (name,) in rows}


def test_drop_intermediates_drops_only_unkept_tables(conn) -> None:
    conn.execute("CREATE SCHEMA ducklake.ds_v1")
    conn.execute("CREATE SCHEMA ducklake.ds_v2")
    for table in ("persons_geocoded", "nyc_eds", "persons_raw", "persons_scored"):
        conn.execute(f"CREATE TABLE ducklake.ds_v1.{table} AS SELECT 1 AS x")
    conn.execute("CREATE TABLE ducklake.ds_v2.persons_raw AS SELECT 1 AS x")

    dropped = drop_intermediates(conn, "ds_v1", frozenset({"persons_geocoded", "nyc_eds"}))

    assert dropped == ["persons_raw", "persons_scored"]
    assert _tables(conn, "ds_v1") == {"persons_geocoded", "nyc_eds"}
    assert _tables(conn, "ds_v2") == {"persons_raw"}


def test_reclaim_schedules_dropped_files_and_keeps_live_data(conn) -> None:
    conn.execute("CREATE SCHEMA ducklake.ds_v1")
    conn.execute("CREATE TABLE ducklake.ds_v1.persons_geocoded AS SELECT range AS x FROM range(1000)")
    conn.execute("CREATE TABLE ducklake.ds_v1.persons_raw AS SELECT range AS x FROM range(1000)")
    drop_intermediates(conn, "ds_v1", frozenset({"persons_geocoded"}))

    reclaim_dropped_files(conn)

    scheduled = conn.execute(
        "SELECT count(*) FROM __ducklake_metadata_ducklake.ducklake_files_scheduled_for_deletion"
    ).fetchone()
    assert scheduled == (1,)
    assert conn.execute("SELECT count(*) FROM ducklake.ds_v1.persons_geocoded").fetchone() == (1000,)
