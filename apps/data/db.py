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
        data_path = f"s3://{settings.ducklake_storage.bucket}/"
        conn.execute(
            f"ATTACH 'ducklake:postgres:{settings.ducklake_metadata_postgres_url}' AS ducklake (DATA_PATH '{data_path}')"
        )
    else:
        # Local dev: DuckDB file catalog + local filesystem
        Path(LOCAL_DATA_DIR).mkdir(exist_ok=True)
        conn.execute(
            f"ATTACH 'ducklake:{LOCAL_CATALOG}' AS ducklake (DATA_PATH '{LOCAL_DATA_DIR}')"
        )

    conn.execute("USE ducklake")
    return conn
