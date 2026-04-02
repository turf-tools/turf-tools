import os
from pathlib import Path

import duckdb

# Local dev paths
LOCAL_CATALOG = "ducklake.ducklake"
LOCAL_DATA_DIR = "local_data/"


def get_connection() -> duckdb.DuckDBPyConnection:
    """Create a DuckDB connection with DuckLake attached."""
    conn = duckdb.connect()
    conn.install_extension("ducklake")
    conn.load_extension("ducklake")

    catalog_url = os.environ.get("DUCKLAKE_METADATA_POSTGRES_URL")

    if catalog_url:
        # Production: Postgres catalog + S3 storage
        data_path = os.environ.get("DUCKLAKE_STORAGE_PATH", "s3://ducklake/")
        conn.execute(
            f"ATTACH 'ducklake:postgres:{catalog_url}' AS ducklake (DATA_PATH '{data_path}')"
        )
    else:
        # Local dev: DuckDB file catalog + local filesystem
        Path(LOCAL_DATA_DIR).mkdir(exist_ok=True)
        conn.execute(
            f"ATTACH 'ducklake:{LOCAL_CATALOG}' AS ducklake (DATA_PATH '{LOCAL_DATA_DIR}')"
        )

    conn.execute("USE ducklake")
    return conn
