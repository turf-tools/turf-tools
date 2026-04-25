from pathlib import Path

import duckdb

from src.settings import Settings

# Local dev paths
LOCAL_CATALOG = "ducklake.ducklake"
LOCAL_DATA_DIR = "local_data/"
LOCAL_GEO_CATALOG = "geo_ducklake.ducklake"
LOCAL_GEO_DATA_DIR = "geo_local_data/"


def get_connection(settings: Settings) -> duckdb.DuckDBPyConnection:
    """Create a DuckDB connection with both DuckLake catalogs attached.

    Attaches:
    - ``ducklake`` -- person data (primary catalog, USE'd by default)
    - ``geo_ducklake`` -- TIGER/blockface reference data (reusable across organizations)

    All three Hamilton graphs share this single connection so that Graph 3
    can perform cross-catalog joins between the two catalogs without copying data.
    """
    conn = duckdb.connect()
    conn.install_extension("ducklake")
    conn.load_extension("ducklake")
    conn.install_extension("spatial")
    conn.load_extension("spatial")

    if settings.ducklake_metadata_postgres_url:
        # Production: Postgres catalog + S3 storage
        catalog_url = settings.ducklake_metadata_postgres_url
        data_path = f"s3://{settings.ducklake_storage.bucket}/"
        conn.execute(f"ATTACH 'ducklake:postgres:{catalog_url}' AS ducklake (DATA_PATH '{data_path}')")
    else:
        # Local dev: DuckDB file catalog + local filesystem
        Path(LOCAL_DATA_DIR).mkdir(exist_ok=True)
        conn.execute(f"ATTACH 'ducklake:{LOCAL_CATALOG}' AS ducklake (DATA_PATH '{LOCAL_DATA_DIR}')")

    if settings.geo_ducklake_metadata_postgres_url:
        # Production: separate Postgres catalog + S3 storage for geo data
        geo_catalog_url = settings.geo_ducklake_metadata_postgres_url
        geo_data_path = f"s3://{settings.geo_ducklake_storage.bucket}/"
        conn.execute(f"ATTACH 'ducklake:postgres:{geo_catalog_url}' AS geo_ducklake (DATA_PATH '{geo_data_path}')")
    else:
        # Local dev: separate DuckDB file catalog + local filesystem for geo data
        Path(LOCAL_GEO_DATA_DIR).mkdir(exist_ok=True)
        conn.execute(f"ATTACH 'ducklake:{LOCAL_GEO_CATALOG}' AS geo_ducklake (DATA_PATH '{LOCAL_GEO_DATA_DIR}')")

    conn.execute("USE ducklake")
    return conn
