from pathlib import Path

import duckdb

# ── SQL helpers (generic) ─────────────────────────────────────────


def _addr_hash(*cols: str) -> str:
    """SQL expression for deterministic address hashing via md5 → valid UUID v4.

    Takes the 32-char MD5 hex and overwrites the version nibble (position 13)
    with '4' and the variant nibble (position 17) with '8' so the result passes
    strict UUID v4 validation (e.g. Zod's `.uuid()`).
    """
    normalized = ["UPPER(TRIM(COALESCE(CAST(" + c + " AS VARCHAR), '')))" for c in cols]
    concatenated = " || '|' || ".join(normalized)
    h = f"md5({concatenated})"
    return (
        f"CAST("
        f"substr({h}, 1, 8) || '-' || "
        f"substr({h}, 9, 4) || '-' || "
        f"'4' || substr({h}, 14, 3) || '-' || "
        f"'8' || substr({h}, 18, 3) || '-' || "
        f"substr({h}, 21, 12) "
        f"AS UUID)"
    )


def _parse_date(col: str) -> str:
    """SQL expression to parse YYYYMMDD string → DATE."""
    cast = f"CAST({col} AS VARCHAR)"
    return f"""
        CASE
            WHEN {cast} IS NOT NULL AND length({cast}) = 8 AND {cast} ~ '^[0-9]{{8}}$'
            THEN CAST(substr({cast}, 1, 4) || '-' || substr({cast}, 5, 2) || '-' || substr({cast}, 7, 2) AS DATE)
            ELSE NULL
        END
    """


# ── State-specific mappers ────────────────────────────────────────


def _map_nys(conn: duckdb.DuckDBPyConnection, file_path: str) -> None:
    """Map NY State BOE voter file columns to a generic schema.

    Creates a temp table `staged_voters` with columns matching the voter_file schema
    (minus voter_file_id, voter_file_version, door_id, building_id, latitude, longitude
    which are added by the generic importer).
    """
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE staged_voters AS
        SELECT
            sboe_id AS voter_id,
            first_name,
            last_name,
            middle_name,
            name_suffix,
            {_parse_date("date_of_birth")} AS date_of_birth,
            gender,
            enrollment AS party,
            status,
            CAST(county_code AS VARCHAR) AS county_code,
            CAST(election_district AS INTEGER) AS precinct,
            CAST(congressional_district AS INTEGER) AS congressional_district,
            CAST(senate_district AS INTEGER) AS senate_district,
            CAST(assembly_district AS INTEGER) AS assembly_district,
            CAST(res_city AS VARCHAR) AS city,
            'NY' AS state,
            CAST(res_zip5 AS VARCHAR) AS zip,
            CAST(ward AS VARCHAR) AS ward,
            {_parse_date("registration_date")} AS registration_date,
            {_parse_date("last_voted_date")} AS last_voted_date,
            voter_history,
            CAST(res_house_number AS VARCHAR) AS house_number,
            CAST(res_street_name AS VARCHAR) AS street_name,
            CAST(res_apartment AS VARCHAR) AS unit
        FROM '{file_path}'
    """)


MAPPERS = {
    "nys_boe": _map_nys,
}


# ── Generic importer ──────────────────────────────────────────────


def get_next_version(conn: duckdb.DuckDBPyConnection, voter_file_id: str) -> int:
    """Get the next voter_file_version for a given voter_file_id."""
    result = conn.execute(
        "SELECT COALESCE(MAX(voter_file_version), 0) FROM voter_file WHERE voter_file_id = ?",
        [voter_file_id],
    ).fetchone()
    return (result[0] if result else 0) + 1


def import_voter_file(conn: duckdb.DuckDBPyConnection, file_path: str, voter_file_id: str = "nys_boe") -> dict:
    """Import a raw voter file parquet into DuckLake tables.

    1. State-specific mapper normalizes raw columns into staged_voters temp table
    2. Generic importer hashes addresses, assigns version, inserts into DuckLake tables
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Voter file not found: {file_path}")

    # Step 1: State-specific column mapping → staged_voters temp table
    mapper = MAPPERS.get(voter_file_id)
    if mapper is None:
        raise ValueError(f"No mapper registered for voter_file_id: {voter_file_id}")
    mapper(conn, file_path)

    # Step 2: Generic import from staged_voters
    version = get_next_version(conn, voter_file_id)

    building_hash = _addr_hash("house_number", "street_name", "city", "state", "zip")
    door_hash = _addr_hash("house_number", "street_name", "unit", "city", "state", "zip")

    conn.execute(f"""
        INSERT INTO voter_file
        SELECT
            voter_id,
            '{voter_file_id}' AS voter_file_id,
            {version} AS voter_file_version,
            {door_hash} AS door_id,
            {building_hash} AS building_id,
            first_name, last_name, middle_name, name_suffix,
            date_of_birth, gender, party, status, county_code,
            precinct, congressional_district, senate_district, assembly_district,
            city, state, zip, ward,
            registration_date, last_voted_date, voter_history,
            house_number, street_name, unit,
            NULL::DOUBLE AS latitude,
            NULL::DOUBLE AS longitude
        FROM staged_voters
    """)

    total_rows = conn.execute(
        "SELECT count(*) FROM voter_file WHERE voter_file_id = ? AND voter_file_version = ?",
        [voter_file_id, version],
    ).fetchone()[0]

    # Extract unique buildings (skip existing)
    conn.execute(f"""
        INSERT INTO buildings
        SELECT DISTINCT ON (building_id)
            building_id, house_number, street_name, city, state, zip,
            NULL::DOUBLE AS latitude, NULL::DOUBLE AS longitude
        FROM voter_file
        WHERE voter_file_id = '{voter_file_id}'
          AND voter_file_version = {version}
          AND building_id NOT IN (SELECT building_id FROM buildings)
    """)

    building_count = conn.execute(
        "SELECT count(DISTINCT building_id) FROM voter_file WHERE voter_file_id = ? AND voter_file_version = ?",
        [voter_file_id, version],
    ).fetchone()[0]

    # Extract unique doors (skip existing)
    conn.execute(f"""
        INSERT INTO doors
        SELECT DISTINCT ON (door_id)
            door_id, building_id, house_number, street_name, unit, city, state, zip,
            NULL::DOUBLE AS latitude, NULL::DOUBLE AS longitude
        FROM voter_file
        WHERE voter_file_id = '{voter_file_id}'
          AND voter_file_version = {version}
          AND door_id NOT IN (SELECT door_id FROM doors)
    """)

    door_count = conn.execute(
        "SELECT count(DISTINCT door_id) FROM voter_file WHERE voter_file_id = ? AND voter_file_version = ?",
        [voter_file_id, version],
    ).fetchone()[0]

    # Clean up
    conn.execute("DROP TABLE IF EXISTS staged_voters")

    return {
        "voter_file_id": voter_file_id,
        "voter_file_version": version,
        "voters_imported": total_rows,
        "buildings": building_count,
        "doors": door_count,
    }
