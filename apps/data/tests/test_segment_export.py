"""Segment export SQL: people and household columns, household names."""

from __future__ import annotations

import pytest

import duckdb
from src.importers.nys_voter_file.manifest import NYS_MANIFEST
from src.models import EXPORT_COLUMNS
from src.segment_export import ExportColumnError, export_sql, household_columns, people_columns

PERSONS = """
    CREATE TABLE persons AS FROM (VALUES
        -- door 1: one person
        ('p1', 'Ada', 'B', 'Lovelace', NULL, '1 MAIN ST', NULL, 1, '1 MAIN ST||10001', 'democratic'),
        -- door 2: two people, one last name
        ('p2', 'Jane', NULL, 'Smith', NULL, '2 MAIN ST', '3B', 2, '2 MAIN ST|3B|10001', 'democratic'),
        ('p3', 'John', NULL, 'Smith', 'JR', '2 MAIN ST', '3B', 2, '2 MAIN ST|3B|10001', 'republican'),
        -- door 3: three people, one last name
        ('p4', 'Al', NULL, 'Ng', NULL, '3 MAIN ST', NULL, 3, '3 MAIN ST||10002', 'democratic'),
        ('p5', 'Bo', NULL, 'Ng', NULL, '3 MAIN ST', NULL, 3, '3 MAIN ST||10002', 'democratic'),
        ('p6', 'Cy', NULL, 'Ng', NULL, '3 MAIN ST', NULL, 3, '3 MAIN ST||10002', 'democratic'),
        -- door 4: two people, two last names
        ('p7', 'Dee', NULL, 'Ray', NULL, '4 MAIN ST', NULL, 4, '4 MAIN ST||10002', 'democratic'),
        ('p8', 'Eve', NULL, 'Cho', NULL, '4 MAIN ST', NULL, 4, '4 MAIN ST||10002', 'democratic'),
        -- door 5: three people, several last names
        ('p9', 'Fay', NULL, 'Kim', NULL, '5 MAIN ST', NULL, 5, '5 MAIN ST||10002', 'democratic'),
        ('pa', 'Gus', NULL, 'Lee', NULL, '5 MAIN ST', NULL, 5, '5 MAIN ST||10002', 'democratic'),
        ('pb', 'Hal', NULL, 'Lee', NULL, '5 MAIN ST', NULL, 5, '5 MAIN ST||10002', 'democratic')
    ) t(external_id, first_name, middle_name, last_name, name_suffix, address_line_1, address_line_2,
        door_i, door_id, enrollment)
"""


def _conn() -> duckdb.DuckDBPyConnection:
    conn = duckdb.connect()
    conn.execute(PERSONS)
    conn.execute("""
        ALTER TABLE persons ADD COLUMN external_id_type VARCHAR DEFAULT 'nys';
        ALTER TABLE persons ADD COLUMN city VARCHAR DEFAULT 'NEW YORK';
        ALTER TABLE persons ADD COLUMN state VARCHAR DEFAULT 'NY';
        ALTER TABLE persons ADD COLUMN zip5 VARCHAR DEFAULT '10001';
        ALTER TABLE persons ADD COLUMN zip4 VARCHAR;
        ALTER TABLE persons ADD COLUMN latitude DOUBLE DEFAULT 40.0;
        ALTER TABLE persons ADD COLUMN longitude DOUBLE DEFAULT -73.0;
    """)
    return conn


def _columns(conn: duckdb.DuckDBPyConnection) -> set[str]:
    return {r[0] for r in conn.execute("DESCRIBE persons").fetchall()}


def _run(conn: duckdb.DuckDBPyConnection, rows, columns, where: str = "", params: list | None = None):
    sql = export_sql(rows, columns, where, NYS_MANIFEST, _columns(conn)).replace("{persons_geocoded}", "persons")
    return conn.execute(sql, params or []).fetchall()


def test_people_columns_are_core_then_manifest_fields_present_in_the_table() -> None:
    present = set(EXPORT_COLUMNS) | {"enrollment", "voting_history", "gender"}
    columns = people_columns(NYS_MANIFEST, present)
    assert columns[: len(EXPORT_COLUMNS)] == EXPORT_COLUMNS
    assert "enrollment" in columns and "gender" in columns
    assert "voting_history" not in columns
    assert "precinct" not in columns  # in the manifest, not in this table
    assert "middle_name" not in people_columns(NYS_MANIFEST, present - {"middle_name"})


def test_people_default_is_the_core_columns_the_table_has() -> None:
    conn = _conn()
    rows = _run(conn, "people", None)
    assert len(rows) == 11
    assert len(rows[0]) == len(EXPORT_COLUMNS)


def test_people_export_the_requested_columns_in_order() -> None:
    conn = _conn()
    rows = _run(conn, "people", ["enrollment", "external_id"], "WHERE door_i = ?", [1])
    assert rows == [("democratic", "p1")]


def test_columns_outside_the_row_type_are_rejected() -> None:
    conn = _conn()
    for rows, columns in (("people", ["door_id"]), ("people", ["household_name"]), ("households", ["enrollment"])):
        with pytest.raises(ExportColumnError):
            _run(conn, rows, columns)
    with pytest.raises(ExportColumnError):
        _run(conn, "people", [])


def test_household_names_follow_who_lives_there() -> None:
    conn = _conn()
    rows = _run(conn, "households", ["household_name", "address_line_2", "zip5"])
    assert rows == [
        ("ADA B LOVELACE", None, "10001"),
        ("JANE & JOHN SMITH", "3B", "10001"),
        ("THE NG FAMILY", None, "10002"),
        ("DEE RAY & EVE CHO", None, "10002"),
        ("OUR FRIENDS AT", None, "10002"),
    ]


def test_households_count_only_segment_members() -> None:
    conn = _conn()
    rows = _run(conn, "households", ["household_name"], "WHERE enrollment = ?", ["democratic"])
    # John (republican) is at Jane's door but not in the segment.
    assert ("JANE SMITH",) in rows


def test_household_default_columns_and_missing_unit_column() -> None:
    conn = _conn()
    assert len(_run(conn, "households", None)[0]) == len(household_columns(_columns(conn)))
    assert "address_line_2" not in household_columns(_columns(conn) - {"address_line_2"})


def test_absent_optional_columns_are_dropped_not_rejected() -> None:
    conn = _conn()
    conn.execute("ALTER TABLE persons DROP COLUMN middle_name")
    assert len(_run(conn, "people", ["external_id", "middle_name"])[0]) == 1
    conn.execute("ALTER TABLE persons DROP COLUMN address_line_2")
    assert len(_run(conn, "households", ["household_name", "address_line_2"])[0]) == 1


def test_names_export_in_capitals_and_group_whatever_their_case() -> None:
    conn = _conn()
    assert _run(conn, "people", ["first_name", "last_name", "enrollment"], "WHERE door_i = ?", [1]) == [
        ("ADA", "LOVELACE", "democratic")
    ]
    conn.execute("UPDATE persons SET last_name = 'SMITH' WHERE external_id = 'p3'")
    rows = _run(conn, "households", ["household_name"], "WHERE door_i = ?", [2])
    assert rows == [("JANE & JOHN SMITH",)]
