import os
from pathlib import Path

import duckdb
from src.settings import Settings

# Local dev paths
LOCAL_CATALOG = "ducklake.ducklake"
LOCAL_DATA_DIR = "local_data/"
LOCAL_GEO_CATALOG = "geo_ducklake.ducklake"
LOCAL_GEO_DATA_DIR = "geo_local_data/"

# Module-level cached connection for the read-only HTTP path. Building
# a fresh DuckDB connection costs ~600ms in production (extension loads,
# CREATE SECRET via AWS credential chain, two ATTACHes against Postgres
# catalogs); every fresh connection also has an empty Parquet page cache,
# so repeat queries re-pay the S3 read cost. One shared connection
# eliminates both overheads. Seeds (`read_only=False`) bypass the cache —
# they manage their own connection lifecycle and need write access.
_shared_ro_conn: duckdb.DuckDBPyConnection | None = None


def get_connection(settings: Settings, *, read_only: bool = False) -> duckdb.DuckDBPyConnection:
    """Return a DuckDB connection with both DuckLake catalogs attached.

    For ``read_only=True`` (HTTP serving paths), returns a process-level
    cached connection. Handlers must NOT call ``conn.close()`` on the
    returned object — that would destroy the shared instance and break
    every subsequent request until the cache rebuilt.

    For ``read_only=False`` (seeds and other writers), returns a fresh
    connection each call. Callers are responsible for ``close()``.
    """
    global _shared_ro_conn
    if read_only:
        if _shared_ro_conn is None:
            _shared_ro_conn = _build_connection(settings, read_only=True)
        return _shared_ro_conn
    return _build_connection(settings, read_only=False)


def _build_connection(settings: Settings, *, read_only: bool) -> duckdb.DuckDBPyConnection:
    """Create a fresh DuckDB connection with both DuckLake catalogs attached.

    Attaches:
    - ``ducklake`` -- person data (primary catalog, USE'd by default)
    - ``geo_ducklake`` -- TIGER/blockface reference data (reusable across organizations)

    All three Hamilton graphs share this single connection so that Graph 3
    can perform cross-catalog joins between the two catalogs without copying data.

    Pass ``read_only=True`` for serving paths (HTTP query endpoints). The
    catalogs are then attached with ``READ_ONLY``, so a bug or compromised
    upstream caller physically cannot mutate the lake. Hamilton ingestion
    DAGs leave it ``False`` (the default).
    """
    conn = duckdb.connect()
    conn.install_extension("ducklake")
    conn.load_extension("ducklake")
    conn.install_extension("spatial")
    conn.load_extension("spatial")

    # Production paths use S3 storage; the SECRET tells DuckDB to walk
    # the AWS credential chain (env vars → shared config → EC2 instance
    # metadata) so we don't have to wire access keys explicitly.
    using_s3 = bool(settings.ducklake_metadata_postgres_url) or bool(settings.geo_ducklake_metadata_postgres_url)
    if using_s3:
        conn.install_extension("httpfs")
        conn.load_extension("httpfs")
        region = os.environ.get("AWS_REGION", "us-east-1")
        conn.execute(f"CREATE SECRET s3_secret (TYPE S3, PROVIDER credential_chain, REGION '{region}')")

    # Buffer pool sizing — DuckDB's default `memory_limit` is conservative
    # on Linux. With the cached connection living for the lifetime of the
    # process, more memory means more Parquet pages stay hot across
    # queries. `threads` > vCPU because the parallelizable work is S3 I/O,
    # not CPU compute. `enable_object_cache` caches Parquet metadata
    # (footers, bloom filters) across queries.
    memory_limit = os.environ.get("DUCKDB_MEMORY_LIMIT", "10GB")
    threads = os.environ.get("DUCKDB_THREADS", "12")
    conn.execute(f"SET memory_limit = '{memory_limit}'")
    conn.execute(f"SET threads = {threads}")
    conn.execute("SET enable_object_cache = true")

    ro = ", READ_ONLY" if read_only else ""

    if settings.ducklake_metadata_postgres_url:
        # Production: Postgres catalog + S3 storage
        catalog_url = settings.ducklake_metadata_postgres_url
        data_path = f"s3://{settings.ducklake_storage.bucket}/"
        conn.execute(f"ATTACH 'ducklake:postgres:{catalog_url}' AS ducklake (DATA_PATH '{data_path}'{ro})")
    else:
        # Local dev: DuckDB file catalog + local filesystem
        Path(LOCAL_DATA_DIR).mkdir(exist_ok=True)
        conn.execute(f"ATTACH 'ducklake:{LOCAL_CATALOG}' AS ducklake (DATA_PATH '{LOCAL_DATA_DIR}'{ro})")

    if settings.geo_ducklake_metadata_postgres_url:
        # Production: separate Postgres catalog + S3 storage for geo data
        geo_catalog_url = settings.geo_ducklake_metadata_postgres_url
        geo_data_path = f"s3://{settings.geo_ducklake_storage.bucket}/"
        conn.execute(f"ATTACH 'ducklake:postgres:{geo_catalog_url}' AS geo_ducklake (DATA_PATH '{geo_data_path}'{ro})")
    else:
        # Local dev: separate DuckDB file catalog + local filesystem for geo data
        Path(LOCAL_GEO_DATA_DIR).mkdir(exist_ok=True)
        conn.execute(f"ATTACH 'ducklake:{LOCAL_GEO_CATALOG}' AS geo_ducklake (DATA_PATH '{LOCAL_GEO_DATA_DIR}'{ro})")

    conn.execute("USE ducklake")
    return conn
