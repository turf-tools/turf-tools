from pathlib import Path

import duckdb

from settings import Settings

# Local dev paths
LOCAL_CATALOG = "ducklake.ducklake"
LOCAL_DATA_DIR = "local_data/"


def get_connection(settings: Settings) -> duckdb.DuckDBPyConnection:
    """Create a DuckDB connection with DuckLake attached."""
    conn = duckdb.connect()
    conn.install_extension("ducklake")
    conn.load_extension("ducklake")

    if settings.ducklake_metadata_postgres_url:
        # Production: Postgres catalog + S3 storage
        catalog_url = settings.ducklake_metadata_postgres_url
        data_path = f"s3://{settings.ducklake_storage.bucket}/"
        conn.execute(f"ATTACH 'ducklake:postgres:{catalog_url}' AS ducklake (DATA_PATH '{data_path}')")
    else:
        # Local dev: DuckDB file catalog + local filesystem
        Path(LOCAL_DATA_DIR).mkdir(exist_ok=True)
        conn.execute(f"ATTACH 'ducklake:{LOCAL_CATALOG}' AS ducklake (DATA_PATH '{LOCAL_DATA_DIR}')")

    conn.execute("USE ducklake")
    return conn


def create_tables(conn: duckdb.DuckDBPyConnection) -> None:
    """Create DuckLake tables if they don't exist."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS voter_file (
            voter_id TEXT,
            voter_file_id TEXT,
            voter_file_version INTEGER,
            door_id TEXT,
            building_id TEXT,
            first_name TEXT,
            last_name TEXT,
            middle_name TEXT,
            name_suffix TEXT,
            date_of_birth DATE,
            gender TEXT,
            party TEXT,
            status TEXT,
            county_code TEXT,
            precinct INTEGER,
            congressional_district INTEGER,
            senate_district INTEGER,
            assembly_district INTEGER,
            city TEXT,
            state TEXT,
            zip TEXT,
            ward TEXT,
            registration_date DATE,
            last_voted_date DATE,
            voter_history TEXT,
            house_number TEXT,
            street_name TEXT,
            unit TEXT,
            latitude DOUBLE,
            longitude DOUBLE
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS buildings (
            building_id TEXT,
            house_number TEXT,
            street_name TEXT,
            city TEXT,
            state TEXT,
            zip TEXT,
            latitude DOUBLE,
            longitude DOUBLE
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS doors (
            door_id TEXT,
            building_id TEXT,
            house_number TEXT,
            street_name TEXT,
            unit TEXT,
            city TEXT,
            state TEXT,
            zip TEXT,
            latitude DOUBLE,
            longitude DOUBLE
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS universe_members (
            universe_id TEXT,
            voter_id TEXT,
            voter_file_id TEXT,
            voter_file_version INTEGER
        )
    """)
