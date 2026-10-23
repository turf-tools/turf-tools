"""Zone import parsing (`parse_zone_file`): the contract the zone editor's
Import dialog relies on. Pure in-memory DuckDB with a stand-in boundary table."""

import pytest

import duckdb
from src.zones import parse_zone_file, write_zone_file


@pytest.fixture
def conn():
    c = duckdb.connect(":memory:")
    c.execute("CREATE TABLE boundaries (key VARCHAR)")
    c.executemany("INSERT INTO boundaries VALUES (?)", [("36-65-1",), ("36-65-2",), ("36-65-3",), ("07030",)])
    yield c
    c.close()


def _csv(tmp_path, text: str) -> str:
    f = tmp_path / "zones.csv"
    f.write_text(text)
    return str(f)


def test_groups_keys_by_zone_in_file_order(conn, tmp_path):
    src = _csv(tmp_path, "ed,neighborhood\n36-65-2,South\n36-65-1,North\n36-65-3,South\n")
    out = parse_zone_file(conn, src, "boundaries")
    assert out["zones"] == [
        {"name": "South", "keys": ["36-65-2", "36-65-3"]},
        {"name": "North", "keys": ["36-65-1"]},
    ]
    assert (out["rowCount"], out["blankCount"], out["unknownCount"]) == (3, 0, 0)


def test_keeps_leading_zeros(conn, tmp_path):
    out = parse_zone_file(conn, _csv(tmp_path, "zip,zone\n07030,Hoboken\n"), "boundaries")
    assert out["zones"] == [{"name": "Hoboken", "keys": ["07030"]}]


def test_trims_and_dedupes_repeated_rows(conn, tmp_path):
    out = parse_zone_file(conn, _csv(tmp_path, "key,zone\n 36-65-1 , North \n36-65-1,North\n"), "boundaries")
    assert out["zones"] == [{"name": "North", "keys": ["36-65-1"]}]


def test_blank_zone_rows_are_skipped_and_counted(conn, tmp_path):
    out = parse_zone_file(conn, _csv(tmp_path, "key,zone\n36-65-1,North\n36-65-2,\n"), "boundaries")
    assert out["zones"] == [{"name": "North", "keys": ["36-65-1"]}]
    assert out["blankCount"] == 1


def test_unknown_keys_are_skipped_and_reported(conn, tmp_path):
    out = parse_zone_file(conn, _csv(tmp_path, "key,zone\n36-65-1,North\n99-99-9,North\n"), "boundaries")
    assert out["zones"] == [{"name": "North", "keys": ["36-65-1"]}]
    assert (out["unknownCount"], out["unknownKeys"]) == (1, ["99-99-9"])


def test_no_matching_keys_fails(conn, tmp_path):
    with pytest.raises(ValueError, match="None of the keys"):
        parse_zone_file(conn, _csv(tmp_path, "key,zone\n11201,North\n"), "boundaries")


def test_key_in_two_zones_fails_naming_it(conn, tmp_path):
    with pytest.raises(ValueError, match="36-65-1"):
        parse_zone_file(conn, _csv(tmp_path, "key,zone\n36-65-1,North\n36-65-1,South\n"), "boundaries")


def test_wrong_column_count_fails(conn, tmp_path):
    with pytest.raises(ValueError, match="two columns"):
        parse_zone_file(conn, _csv(tmp_path, "key\n36-65-1\n"), "boundaries")


@pytest.mark.parametrize("fmt", ["csv", "parquet"])
def test_export_round_trips(conn, tmp_path, fmt):
    zones = [("North", ["36-65-2", "36-65-1"]), ("South", ["07030"])]
    path = str(tmp_path / f"zones.{fmt}")
    write_zone_file(conn, zones, path, fmt)
    out = parse_zone_file(conn, path, "boundaries")
    assert [(z["name"], z["keys"]) for z in out["zones"]] == zones


def test_parquet_integer_keys_become_text(conn, tmp_path):
    path = str(tmp_path / "zones.parquet")
    conn.execute(f"COPY (SELECT 7030 AS zip, 'Hoboken' AS zone) TO '{path}' (FORMAT parquet)")
    # An integer column has already lost the leading zero; it reads as "7030"
    # and is reported unknown rather than silently matched.
    with pytest.raises(ValueError, match="None of the keys"):
        parse_zone_file(conn, path, "boundaries")
