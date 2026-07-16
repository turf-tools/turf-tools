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

    # S3 storage (identified by a configured bucket) needs the SECRET so DuckDB
    # walks the AWS credential chain. Catalog backend (Postgres vs local file) is
    # an *independent* axis — dev runs a Postgres catalog with *local* storage.
    using_s3 = bool(settings.ducklake_storage.bucket) or bool(settings.geo_ducklake_storage.bucket)
    if using_s3:
        conn.install_extension("httpfs")
        conn.load_extension("httpfs")
        _create_or_replace_s3_secret(conn)

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
    _attach_ducklake(
        conn,
        "ducklake",
        pg_url=settings.ducklake_metadata_postgres_url,
        meta_schema=settings.ducklake_meta_schema,
        local_catalog=LOCAL_CATALOG,
        local_data_dir=LOCAL_DATA_DIR,
        bucket=settings.ducklake_storage.bucket,
        read_only_opt=ro,
    )
    _attach_ducklake(
        conn,
        "geo_ducklake",
        pg_url=settings.geo_ducklake_metadata_postgres_url,
        meta_schema=settings.geo_ducklake_meta_schema,
        local_catalog=LOCAL_GEO_CATALOG,
        local_data_dir=LOCAL_GEO_DATA_DIR,
        bucket=settings.geo_ducklake_storage.bucket,
        read_only_opt=ro,
    )

    conn.execute("USE ducklake")
    return conn


def _attach_ducklake(
    conn: duckdb.DuckDBPyConnection,
    alias: str,
    *,
    pg_url: str | None,
    meta_schema: str | None,
    local_catalog: str,
    local_data_dir: str,
    bucket: str,
    read_only_opt: str,
) -> None:
    """Attach one DuckLake catalog. Catalog backend (Postgres vs local DuckDB
    file) and storage (S3 vs local dir) are independent axes:

    - **prod:** Postgres catalog + S3 storage (bucket set).
    - **dev:** Postgres catalog (concurrency-safe, unlike a single-writer local
      file) + local storage. Two catalogs share one dev Postgres DB via distinct
      `META_SCHEMA`s; DuckLake requires the schema to pre-exist, so we ensure it.
    - **file fallback:** local DuckDB-file catalog + local dir (no Postgres).
    """
    data_path = f"s3://{bucket}/" if bucket else local_data_dir
    if not bucket:
        Path(local_data_dir).mkdir(exist_ok=True)

    if not pg_url:
        conn.execute(f"ATTACH 'ducklake:{local_catalog}' AS {alias} (DATA_PATH '{data_path}'{read_only_opt})")
        return

    conn.install_extension("postgres")
    conn.load_extension("postgres")
    schema_opt = ""
    if meta_schema:
        conn.execute(f"ATTACH '{pg_url}' AS _meta_{alias} (TYPE postgres)")
        conn.execute(f"CREATE SCHEMA IF NOT EXISTS _meta_{alias}.{meta_schema}")
        conn.execute(f"DETACH _meta_{alias}")
        schema_opt = f", META_SCHEMA '{meta_schema}'"
    conn.execute(f"ATTACH 'ducklake:postgres:{pg_url}' AS {alias} (DATA_PATH '{data_path}'{schema_opt}{read_only_opt})")


def _create_or_replace_s3_secret(conn: duckdb.DuckDBPyConnection) -> None:
    """(Re)create the S3 SECRET that authorises DuckDB's httpfs reads.

    Called once at connection build and then periodically from the FastAPI
    lifespan to refresh credentials. `CREATE OR REPLACE` is atomic at the
    secrets-manager level; in-flight queries that already resolved the
    secret keep their token snapshot (still valid for hours), and new
    queries pick up the new triple. `VALIDATION 'none'` keeps a transient
    IMDS blip from killing the service.

    Note: `REFRESH 'auto'` is documented but is a no-op for plain
    `credential_chain` on EC2 instance profile — DuckDB only wires the
    refresh hook into the STS / web_identity branches (see duckdb-aws#26).
    That's why we drive the refresh ourselves from lifespan.
    """
    region = os.environ.get("AWS_REGION", "us-east-1")
    conn.execute(
        f"CREATE OR REPLACE SECRET s3_secret (TYPE S3, PROVIDER credential_chain, REGION '{region}', VALIDATION 'none')"
    )


def refresh_s3_secret_on_shared_connection(settings: Settings) -> None:
    """Force-refresh the S3 credentials on the cached read-only connection.

    Safe no-op when the connection hasn't been built yet (cold process)
    or when S3 isn't in use (local dev). Caller is responsible for the
    schedule — see the lifespan task in `main.py`.
    """
    if _shared_ro_conn is None:
        return
    using_s3 = bool(settings.ducklake_metadata_postgres_url) or bool(settings.geo_ducklake_metadata_postgres_url)
    if not using_s3:
        return
    _create_or_replace_s3_secret(_shared_ro_conn)


# Alias under which the operational Postgres database is mounted into
# DuckDB by `attach_operational_postgres`. Cross-database SQL refers to
# tables as `operational_pg.public.<table>`.
OPERATIONAL_PG_ALIAS = "operational_pg"


def attach_operational_postgres(conn: duckdb.DuckDBPyConnection, settings: Settings) -> None:
    """Install + load DuckDB's `postgres` extension and ATTACH the operational
    Postgres database under `OPERATIONAL_PG_ALIAS`.

    Idempotent — safe to call repeatedly on a connection. Used by paths that
    need to read or write operational tables in the same DuckDB session as
    DuckLake (e.g. turf publish, future auto-cut), so cross-database SQL can
    join filtered_persons + buildings against operational rows in one
    transaction without round-tripping through Python.

    Raises ``RuntimeError`` if ``DATABASE_URL`` isn't configured. Callers in
    HTTP contexts can catch and re-raise as ``HTTPException``; jobs surface
    it as the job's failure reason.
    """
    if not settings.database_url:
        raise RuntimeError("DATABASE_URL is not configured.")
    conn.install_extension("postgres")
    conn.load_extension("postgres")
    # Single quotes in the URL escaped via double-up; ATTACH IF NOT EXISTS
    # makes this a no-op if a previous call on the same connection already
    # attached.
    escaped = settings.database_url.replace("'", "''")
    conn.execute(f"ATTACH IF NOT EXISTS '{escaped}' AS {OPERATIONAL_PG_ALIAS} (TYPE postgres)")
