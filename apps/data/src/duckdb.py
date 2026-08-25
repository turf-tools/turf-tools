import os
import tempfile
import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

import duckdb
from src.settings import Settings

# Local dev paths
LOCAL_CATALOG = "ducklake.ducklake"
LOCAL_DATA_DIR = "local_data/"
LOCAL_DUCKLAKE_GEO_CATALOG = "ducklake_geo.ducklake"
LOCAL_DUCKLAKE_GEO_DATA_DIR = "ducklake_geo_local_data/"

# Module-level cached connection for the read-only HTTP path. Building
# a fresh DuckDB connection costs ~600ms in production (extension loads,
# CREATE SECRET via AWS credential chain, two ATTACHes against Postgres
# catalogs); every fresh connection also has an empty Parquet page cache,
# so repeat queries re-pay the S3 read cost. One shared connection
# eliminates both overheads. Seeds (`read_only=False`) bypass the cache —
# they manage their own connection lifecycle and need write access.
_shared_ro_conn: duckdb.DuckDBPyConnection | None = None
_shared_ro_lock = threading.Lock()


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
        # Query threads reach this concurrently, so guard the lazy build:
        # two racing builders would each ATTACH the DuckLake catalog, which
        # a local-file catalog forbids, and one of them would be discarded
        # still holding its attachments.
        if _shared_ro_conn is None:
            with _shared_ro_lock:
                if _shared_ro_conn is None:
                    _shared_ro_conn = _build_connection(settings, read_only=True)
        return _shared_ro_conn
    return _build_connection(settings, read_only=False)


@contextmanager
def query_cursor(settings: Settings) -> Iterator[duckdb.DuckDBPyConnection]:
    """A short-lived cursor over the shared read-only connection.

    A connection object cannot be driven from two threads at once — the
    statements interleave and corrupt each other's state — so anything
    running off the event loop needs its own. A cursor is an independent
    connection over the same database instance: it shares the buffer pool,
    the attached catalogs and the instance settings (the whole point of
    caching one connection) while keeping its own query and transaction
    state. `USE` is per-connection and is not inherited from the parent, so
    re-apply it — unqualified names (SHOW TABLES, DESCRIBE) depend on it.
    """
    cursor = get_connection(settings, read_only=True).cursor()
    try:
        cursor.execute("USE ducklake")
        yield cursor
    finally:
        cursor.close()


def _build_connection(settings: Settings, *, read_only: bool) -> duckdb.DuckDBPyConnection:
    """Create a fresh DuckDB connection with both DuckLake catalogs attached.

    Attaches:
    - ``ducklake`` -- person data (primary catalog, USE'd by default)
    - ``ducklake_geo`` -- TIGER/blockface reference data (reusable across organizations)

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
    using_s3 = bool(settings.storage.bucket)
    if using_s3:
        conn.install_extension("httpfs")
        conn.load_extension("httpfs")
        _create_or_replace_s3_secret(conn, settings)

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

    # Spill space. An in-memory DuckDB has no temp_directory, so an operator
    # that crosses memory_limit errors out instead of going out-of-core;
    # with one set, work stays in RAM up to the limit and degrades to disk
    # past it. Per-connection subdir — concurrent connections (shared RO +
    # an import) must not share temp files. Pre-created: DuckDB only creates
    # the leaf directory, so a missing parent fails at first spill.
    temp_base = os.environ.get("DUCKDB_TEMP_DIRECTORY") or os.path.join(tempfile.gettempdir(), "duckdb-spill")
    spill_dir = os.path.join(temp_base, uuid.uuid4().hex)
    os.makedirs(spill_dir, exist_ok=True)
    conn.execute(f"SET temp_directory = '{_sql_str(spill_dir)}'")

    ro = ", READ_ONLY" if read_only else ""
    _attach_ducklake(
        conn,
        "ducklake",
        pg_url=settings.ducklake_metadata_postgres_url,
        meta_schema=settings.ducklake_meta_schema,
        local_catalog=LOCAL_CATALOG,
        local_data_dir=LOCAL_DATA_DIR,
        bucket=settings.storage.bucket,
        prefix=settings.ducklake_prefix,
        read_only_opt=ro,
    )
    _attach_ducklake(
        conn,
        "ducklake_geo",
        pg_url=settings.ducklake_geo_metadata_postgres_url,
        meta_schema=settings.ducklake_geo_meta_schema,
        local_catalog=LOCAL_DUCKLAKE_GEO_CATALOG,
        local_data_dir=LOCAL_DUCKLAKE_GEO_DATA_DIR,
        bucket=settings.storage.bucket,
        prefix=settings.ducklake_geo_prefix,
        read_only_opt=ro,
    )

    conn.execute("USE ducklake")
    return conn


def _attach_ducklake(
    conn: duckdb.DuckDBPyConnection,
    alias: str,
    *,
    pg_url: str | None,
    meta_schema: str,
    local_catalog: str,
    local_data_dir: str,
    bucket: str,
    prefix: str,
    read_only_opt: str,
) -> None:
    """Attach one DuckLake catalog. Catalog backend (Postgres vs local DuckDB
    file) and storage (S3 vs local dir) are independent axes:

    - **prod:** Postgres catalog (a DB per catalog) + S3 storage (bucket set).
    - **dev:** Postgres catalog (concurrency-safe, unlike a single-writer local
      file) + local storage. Two catalogs share the one dev Postgres DB.
    - **file fallback:** local DuckDB-file catalog + local dir (no Postgres).

    Postgres catalogs always use `META_SCHEMA` (`catalog`/`catalog_geo`) — the
    same schema names in every environment; only the database differs. DuckLake
    requires the schema to pre-exist, so we ensure it.
    """
    data_path = _s3_path(bucket, prefix) if bucket else local_data_dir
    if not bucket:
        Path(local_data_dir).mkdir(exist_ok=True)

    if not pg_url:
        conn.execute(f"ATTACH 'ducklake:{local_catalog}' AS {alias} (DATA_PATH '{data_path}'{read_only_opt})")
        return

    conn.install_extension("postgres")
    conn.load_extension("postgres")
    conn.execute(f"ATTACH '{pg_url}' AS _meta_{alias} (TYPE postgres)")
    conn.execute(f"CREATE SCHEMA IF NOT EXISTS _meta_{alias}.{meta_schema}")
    conn.execute(f"DETACH _meta_{alias}")
    schema_opt = f", META_SCHEMA '{meta_schema}'"
    conn.execute(f"ATTACH 'ducklake:postgres:{pg_url}' AS {alias} (DATA_PATH '{data_path}'{schema_opt}{read_only_opt})")


def _s3_path(bucket: str, prefix: str) -> str:
    """`s3://bucket/prefix/`, or `s3://bucket/` when no prefix is set."""
    return f"s3://{bucket}/{prefix.strip('/')}/" if prefix.strip("/") else f"s3://{bucket}/"


def _create_or_replace_s3_secret(conn: duckdb.DuckDBPyConnection, settings: Settings) -> None:
    """(Re)create the S3 SECRET authorising DuckDB's httpfs reads.

    Explicit endpoint (Latitude, DO Spaces) means a static key pair scoped to
    the deployment's bucket. Without one, fall back to the AWS credential chain,
    whose tokens expire — hence the refresh in `main.py`'s lifespan.
    `VALIDATION 'none'` keeps a transient IMDS blip from killing the service.
    """
    cfg = settings.storage
    if cfg.endpoint_url:
        parsed = urlparse(cfg.endpoint_url if "//" in cfg.endpoint_url else f"//{cfg.endpoint_url}")
        host = parsed.netloc or parsed.path
        use_ssl = "true" if parsed.scheme != "http" else "false"
        conn.execute(
            "CREATE OR REPLACE SECRET s3_secret ("
            f"  TYPE S3,"
            f"  KEY_ID '{_sql_str(cfg.access_key_id)}',"
            f"  SECRET '{_sql_str(cfg.secret_access_key)}',"
            f"  ENDPOINT '{_sql_str(host)}',"
            f"  URL_STYLE '{_sql_str(cfg.url_style)}',"
            f"  REGION '{_sql_str(cfg.region)}',"
            f"  USE_SSL {use_ssl},"
            f"  SCOPE 's3://{_sql_str(cfg.bucket)}')"
        )
        return
    region = _sql_str(os.environ.get("AWS_REGION", "us-east-1"))
    conn.execute(
        f"CREATE OR REPLACE SECRET s3_secret (TYPE S3, PROVIDER credential_chain, REGION '{region}', VALIDATION 'none')"
    )


def _sql_str(value: str) -> str:
    """Escape a value for interpolation inside a single-quoted SQL literal."""
    return value.replace("'", "''")


def s3_secret_expires(settings: Settings) -> bool:
    """Whether the S3 credentials are the expiring kind.

    Only the AWS credential chain hands out temporary tokens; explicit static
    keys never expire, so there is nothing to refresh.
    """
    return bool(settings.storage.bucket) and not settings.storage.endpoint_url


def refresh_s3_secret_on_shared_connection(settings: Settings) -> None:
    """Force-refresh the S3 credentials on the cached read-only connection.

    No-op when the connection hasn't been built yet (cold process). Caller is
    responsible for the schedule — see the lifespan task in `main.py`.
    """
    if _shared_ro_conn is None:
        return
    _create_or_replace_s3_secret(_shared_ro_conn, settings)


# Alias under which the operational Postgres database is mounted into
# DuckDB by `attach_operational_postgres`. Cross-database SQL refers to
# tables as `operational_pg.app.<table>`.
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
    try:
        conn.execute(f"ATTACH IF NOT EXISTS '{escaped}' AS {OPERATIONAL_PG_ALIAS} (TYPE postgres)")
    except duckdb.BinderException as e:
        # Concurrent cursors can race the IF NOT EXISTS check; the loser
        # errors "already exists" — which is the desired end state.
        if "already exists" not in str(e):
            raise


def heal_stale_attach[T](conn: duckdb.DuckDBPyConnection, run: Callable[[], T]) -> T:
    """Run a query that touches the operational attach, healing the postgres
    extension's catalog cache once on a miss.

    The extension builds its catalog cache at first query, so on a fresh
    deployment a query that lands before the first schema push freezes the
    schema-less state into this connection permanently. `pg_clear_cache`
    rebuilds it; one retry covers that window. A genuinely missing table
    re-raises after the single retry.
    """
    try:
        return run()
    except duckdb.CatalogException:
        conn.execute("CALL pg_clear_cache()")
        return run()
