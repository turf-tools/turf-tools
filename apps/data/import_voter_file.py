from pathlib import Path

import duckdb


def get_next_version(conn: duckdb.DuckDBPyConnection, voter_file_id: str) -> int:
    """Get the next voter_file_version for a given voter_file_id."""
    result = conn.execute(
        "SELECT COALESCE(MAX(voter_file_version), 0) FROM voter_file WHERE voter_file_id = ?",
        [voter_file_id],
    ).fetchone()
    return (result[0] if result else 0) + 1


def import_voter_file(conn: duckdb.DuckDBPyConnection, file_path: str, voter_file_id: str = "nys_boe") -> dict:
    """Import a raw voter file parquet into DuckLake tables.

    All transformations run in DuckDB SQL for performance on large files.
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Voter file not found: {file_path}")

    version = get_next_version(conn, voter_file_id)
    state = "NY"  # TODO: derive from voter_file_id

    # Helper SQL for deterministic address hashing via md5 → UUID
    # Normalizes: uppercase, trim, collapse whitespace, join with pipe separator
    def addr_hash(*cols: str) -> str:
        normalized = ["UPPER(TRIM(COALESCE(CAST(" + c + " AS VARCHAR), '')))" for c in cols]
        concatenated = " || '|' || ".join(normalized)
        return "CAST(md5(" + concatenated + ") AS UUID)"

    building_hash = addr_hash("res_house_number", "res_street_name", "res_city", "'" + state + "'", "res_zip5")
    door_hash = addr_hash(
        "res_house_number", "res_street_name", "res_apartment", "res_city", "'" + state + "'", "res_zip5"
    )

    # Helper for date parsing: YYYYMMDD string → DATE
    def parse_date(col: str) -> str:
        cast = f"CAST({col} AS VARCHAR)"
        return f"""
            CASE
                WHEN {cast} IS NOT NULL AND length({cast}) = 8 AND {cast} ~ '^[0-9]{{8}}$'
                THEN CAST(substr({cast}, 1, 4) || '-' || substr({cast}, 5, 2) || '-' || substr({cast}, 7, 2) AS DATE)
                ELSE NULL
            END
        """

    # Insert into voter_file with column mapping
    conn.execute(f"""
        INSERT INTO voter_file
        SELECT
            sboe_id AS voter_id,
            '{voter_file_id}' AS voter_file_id,
            {version} AS voter_file_version,
            {door_hash} AS door_id,
            {building_hash} AS building_id,
            first_name,
            last_name,
            middle_name,
            name_suffix,
            {parse_date("date_of_birth")} AS date_of_birth,
            gender,
            enrollment AS party,
            status,
            CAST(county_code AS VARCHAR) AS county_code,
            CAST(election_district AS INTEGER) AS precinct,
            CAST(congressional_district AS INTEGER) AS congressional_district,
            CAST(senate_district AS INTEGER) AS senate_district,
            CAST(assembly_district AS INTEGER) AS assembly_district,
            CAST(res_city AS VARCHAR) AS city,
            '{state}' AS state,
            CAST(res_zip5 AS VARCHAR) AS zip,
            CAST(ward AS VARCHAR) AS ward,
            {parse_date("registration_date")} AS registration_date,
            {parse_date("last_voted_date")} AS last_voted_date,
            voter_history,
            CAST(res_house_number AS VARCHAR) AS house_number,
            CAST(res_street_name AS VARCHAR) AS street_name,
            CAST(res_apartment AS VARCHAR) AS unit,
            NULL::DOUBLE AS latitude,
            NULL::DOUBLE AS longitude
        FROM '{file_path}'
    """)

    total_rows = conn.execute(
        "SELECT count(*) FROM voter_file WHERE voter_file_id = ? AND voter_file_version = ?",
        [voter_file_id, version],
    ).fetchone()[0]

    # Extract unique buildings and insert (skip existing)
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

    # Extract unique doors and insert (skip existing)
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

    return {
        "voter_file_id": voter_file_id,
        "voter_file_version": version,
        "voters_imported": total_rows,
        "buildings": building_count,
        "doors": door_count,
    }
