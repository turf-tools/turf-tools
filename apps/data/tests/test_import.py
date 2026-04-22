import os

from src.db import create_tables
from import_voter_file import import_voter_file

FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "..", "fixtures", "nys-voters-2026-03-08-ad-65-ed-39.parquet")


def test_import_voter_file(conn):
    create_tables(conn)

    result = import_voter_file(conn, FIXTURE_PATH, "nys_boe")

    assert result["voter_file_id"] == "nys_boe"
    assert result["voter_file_version"] == 1
    assert result["voters_imported"] == 537
    assert result["buildings"] == 41
    assert result["doors"] == 390

    # Verify data is in the tables
    voter_count = conn.execute("SELECT count(*) FROM voter_file").fetchone()[0]
    assert voter_count == 537

    # Check column mapping
    sample = conn.execute("SELECT voter_id, party, precinct, city, state FROM voter_file LIMIT 1").fetchone()
    assert sample[0] is not None  # voter_id (was sboe_id)
    assert sample[3] is not None  # city (was res_city)
    assert sample[4] == "NY"  # state was added

    # Check building/door IDs are UUIDs
    bid = conn.execute("SELECT building_id FROM voter_file LIMIT 1").fetchone()[0]
    assert len(bid) == 36 and bid.count("-") == 4  # UUID format

    # Check dates were parsed
    dob = conn.execute("SELECT date_of_birth FROM voter_file WHERE date_of_birth IS NOT NULL LIMIT 1").fetchone()
    assert dob is not None


def test_import_increments_version(conn):
    create_tables(conn)

    result1 = import_voter_file(conn, FIXTURE_PATH, "nys_boe")
    result2 = import_voter_file(conn, FIXTURE_PATH, "nys_boe")

    assert result1["voter_file_version"] == 1
    assert result2["voter_file_version"] == 2

    total = conn.execute("SELECT count(*) FROM voter_file WHERE voter_file_id = 'nys_boe'").fetchone()[0]
    assert total == 537 * 2
