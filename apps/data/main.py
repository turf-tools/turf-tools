import array
import asyncio
import logging
import os
import tempfile
from contextlib import asynccontextmanager, suppress
from typing import Any

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.background import BackgroundTask

import src.import_job  # noqa: F401 — registers the `import_dataset_version` job with the worker
from src.dsl.compile import boundary_key_expr_for, cascade_sql, criteria_to_where
from src.dsl.criteria import Criteria, KeyFilter, build_field_catalog
from src.dsl.resolve import resolve_criteria
from src.duckdb import get_connection, refresh_s3_secret_on_shared_connection
from src.job_runner import JobManager
from src.publish_turfs import PublishTurfsRequest, publish_turfs
from src.settings import get_settings
from src.tables import NoActiveDatasetError, resolve, resolve_version, table_fqn

logger = logging.getLogger("uvicorn")

settings = get_settings()


def _log_background_task_failure(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    try:
        exc = task.exception()
    except asyncio.CancelledError:
        return
    if exc is not None:
        logger.exception("Background task %s stopped unexpectedly", task.get_name(), exc_info=exc)


# Cadence for forcing a fresh credential-chain walk on the shared DuckDB
# connection. EC2 instance-profile STS tokens are typically valid for ~6h;
# 30 min leaves comfortable headroom for clock skew and scheduling slop.
# Driven manually because DuckDB's `REFRESH 'auto'` is wired only into the
# STS / web_identity branches of credential_chain (duckdb-aws#26).
_S3_SECRET_REFRESH_INTERVAL_SECONDS = 30 * 60


async def _refresh_s3_secret_forever() -> None:
    while True:
        await asyncio.sleep(_S3_SECRET_REFRESH_INTERVAL_SECONDS)
        try:
            # IMDS network call inside CREATE OR REPLACE — keep it off the
            # event loop so concurrent request handling doesn't pause.
            await asyncio.to_thread(refresh_s3_secret_on_shared_connection, settings)
            logger.info("Refreshed S3 SECRET on shared DuckDB connection")
        except Exception:
            logger.exception("S3 SECRET refresh failed; will retry on next tick")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # A read-only attach can't create a DuckLake catalog that doesn't exist yet
    # (a fresh box, before any import or seed). Build a write connection first —
    # its attach creates the empty catalogs if missing — so the read-only warmup
    # and serving paths can attach them. Idempotent; a no-op once they exist.
    try:
        get_connection(settings, read_only=False).close()
    except Exception:
        logger.exception("DuckLake catalog init failed; continuing")

    # Warm the shared connection's buffer pool so the first user request
    # doesn't pay cold S3 round-trips for Parquet footers + page reads.
    try:
        conn = get_connection(settings, read_only=True)
        # `count(COLUMNS(*))` expands at parse time to count(col1), count(col2), …
        # forcing DuckDB to read every column from Parquet — populates the buffer
        # pool so segment filtering + publish don't pay column-cold I/O on the
        # first user request.
        tables = conn.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_catalog = 'ducklake' AND ("
            "  table_name LIKE '%_persons_geocoded' "
            "  OR table_name LIKE '%_doors_geocoded' "
            "  OR table_name LIKE '%_buildings_geocoded'"
            ")"
        ).fetchall()
        for (table,) in tables:
            conn.execute(f'SELECT count(COLUMNS(*)) FROM "{table}"').fetchone()
        logger.info("Warmup completed")
    except Exception:
        logger.exception("Warmup failed; continuing")

    # Create the asyncpg pool eagerly so a misconfigured DATABASE_URL
    # fails startup loudly instead of silently breaking the first job poll.
    from src.postgres import close_pool, get_pool

    await get_pool()

    job_manager_task = asyncio.create_task(JobManager().run_forever(), name="job-manager")
    job_manager_task.add_done_callback(_log_background_task_failure)

    s3_refresh_task = asyncio.create_task(_refresh_s3_secret_forever(), name="s3-secret-refresh")
    s3_refresh_task.add_done_callback(_log_background_task_failure)

    try:
        yield
    finally:
        s3_refresh_task.cancel()
        job_manager_task.cancel()
        with suppress(asyncio.CancelledError):
            await s3_refresh_task
        with suppress(asyncio.CancelledError):
            await job_manager_task
        await close_pool()


# Read-side HTTP surface for the data service. Heavy work — voter-file
# loading, geocoding, Quickwit indexing — runs as Hamilton DAGs via CLI
# jobs. This service exposes health and endpoints for data queries.
app = FastAPI(title="Data Service", lifespan=lifespan)

# Permissive CORS for dev. Lock down via a
# settings-driven allow list before deploying.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.exception_handler(NoActiveDatasetError)
async def _no_active_dataset_handler(_request, exc: NoActiveDatasetError) -> JSONResponse:
    # An org that hasn't activated a dataset version yet is an expected empty
    # state, not a server fault. The web gates data-dependent views on this
    # (`organizations.active_dataset_version_id` is null), but any request that slips
    # through gets a clean 409 with a stable `code` instead of a 500 stack trace.
    return JSONResponse(
        status_code=409,
        content={"detail": str(exc), "code": "no_active_dataset"},
    )


@app.get("/healthcheck")
async def healthcheck():
    return {"status": "ok"}


@app.get("/ducklake/status")
async def ducklake_status():
    conn = get_connection(settings, read_only=True)
    tables = conn.execute("SHOW TABLES").fetchall()
    table_info = {}
    for (table_name,) in tables:
        columns = conn.execute(f"DESCRIBE {table_name}").fetchall()
        table_info[table_name] = [{"name": col[0], "type": col[1]} for col in columns]
    return {
        "status": "ok",
        "tables": table_info,
    }


@app.get("/key-groups/{key_group}/geojson")
async def key_group_geojson(key_group: str, org_slug: str):
    """Serve all polygons for a key group as a GeoJSON FeatureCollection.

    Reads from ``ducklake.{org_slug}.{key_group}`` (populated by the
    `seed-boundaries` CLI). Polygons are pre-simplified at load time, so the
    response is sized for map rendering rather than raw fidelity.

    Cached aggressively — boundary tables only change when an admin
    re-seeds them. When that happens, append a bumped `?v=` query param at
    the call site to bust browser caches.
    """
    conn = get_connection(settings, read_only=True)
    schema = resolve_version(conn, settings, org_slug).schema
    # Validate the table exists before querying — keeps the error message
    # friendlier than a generic SQL failure.
    fqn = table_fqn(schema, key_group)
    try:
        conn.execute(f"SELECT 1 FROM {fqn} LIMIT 0")
    except Exception as e:
        raise HTTPException(
            status_code=404,
            detail=f"No boundary table for org_slug={org_slug}, key_group={key_group}. Run `uv run seed-boundaries`.",
        ) from e

    # Build the FeatureCollection in DuckDB to avoid pulling raw geometry
    # into Python and re-serializing.
    rows = conn.execute(f"""
        SELECT json_object(
            'type', 'FeatureCollection',
            'features', json_group_array(json_object(
                'type', 'Feature',
                'properties', json_object('key', key, 'name', name),
                'geometry', ST_AsGeoJSON(geom)::JSON
            ))
        )
        FROM {fqn}
    """).fetchone()
    body = rows[0] if rows else '{"type":"FeatureCollection","features":[]}'

    return Response(
        content=body,
        media_type="application/geo+json",
        headers={
            # Effectively forever; bust by versioning the URL when contents change.
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


# Request models accept the camelCase wire shape sent by the TS web tier
# while exposing snake_case Python attributes. `populate_by_name=True` lets
# internal callers (tests, ad-hoc construction) use the Python field name.
class _WireBaseModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class _PersonsCountRequest(_WireBaseModel):
    criteria: Criteria = Criteria()
    key_filter: KeyFilter | None = Field(default=None, validation_alias="keyFilter")
    org_slug: str = Field(validation_alias="orgSlug")


@app.post("/persons/count")
async def persons_count(req: _PersonsCountRequest):
    """Persons-level summary counts.

    Response shape: ``{personCount, doorCount, buildingCount}``.
    """
    conn = get_connection(settings, read_only=True)
    version = resolve_version(conn, settings, req.org_slug)
    schema = version.schema
    catalog = build_field_catalog(version.manifest)
    criteria = resolve_criteria(req.criteria, conn, settings, req.org_slug)
    params: list = []
    where = criteria_to_where(catalog, criteria, req.key_filter, params)
    sql = resolve(
        f"""
        SELECT
            count(*) AS "personCount",
            count(DISTINCT door_id) AS "doorCount",
            count(DISTINCT building_id) AS "buildingCount"
        FROM {{persons_geocoded}}
        {where}
        """,
        schema,
    )
    row = conn.execute(sql, params).fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="Persons count query returned no rows.")
    return {
        "personCount": row[0],
        "doorCount": row[1],
        "buildingCount": row[2],
    }


class _PersonsCountCascadeRequest(_WireBaseModel):
    criteria: Criteria = Criteria()
    org_slug: str = Field(validation_alias="orgSlug")


@app.post("/persons/count-cascade")
async def persons_count_cascade(req: _PersonsCountCascadeRequest):
    """Per-step person counts for the segment editor's waterfall panel.

    Returns one row per step (plus a baseline "all" row at index 0). Each
    row carries the absolute count after that step and the delta vs the
    prior row. The step verb (add/narrow/remove) determines how each step
    modifies the running set.
    """
    conn = get_connection(settings, read_only=True)
    version = resolve_version(conn, settings, req.org_slug)
    catalog = build_field_catalog(version.manifest)
    criteria = resolve_criteria(req.criteria, conn, settings, req.org_slug)
    persons_table = resolve("{persons_geocoded}", version.schema)
    params: list = []
    sql = cascade_sql(catalog, criteria, persons_table, params)
    row = conn.execute(sql, params).fetchone()
    counts = list(row)
    steps_result = []
    prev = counts[0]
    steps_result.append({"count": prev, "delta": None})
    for c in counts[1:]:
        steps_result.append({"count": c, "delta": c - prev})
        prev = c
    return {"steps": steps_result}


class _PersonsSampleRequest(_WireBaseModel):
    criteria: Criteria = Criteria()
    key_filter: KeyFilter | None = Field(default=None, validation_alias="keyFilter")
    org_slug: str = Field(validation_alias="orgSlug")
    limit: int = 100


@app.post("/persons/sample")
async def persons_sample(req: _PersonsSampleRequest):
    """Row-level sample of people matching the criteria.

    Response shape: ``{persons: [{firstName, middleName, lastName, nameSuffix,
    addressLine1, addressLine2, city, state, zip5}, ...]}``. Used by the segment
    editor's list-view preview. Capped at ``limit`` (default 100).
    """
    limit = max(1, min(req.limit, 500))
    conn = get_connection(settings, read_only=True)
    version = resolve_version(conn, settings, req.org_slug)
    schema = version.schema
    catalog = build_field_catalog(version.manifest)
    criteria = resolve_criteria(req.criteria, conn, settings, req.org_slug)
    params: list = []
    where = criteria_to_where(catalog, criteria, req.key_filter, params)
    sql = resolve(
        f"""
        SELECT * FROM (
            SELECT first_name, middle_name, last_name, name_suffix,
                   address_line_1, address_line_2, city, state, zip5
            FROM {{persons_geocoded}}
            {where}
        ) USING SAMPLE {limit} ROWS
        """,
        schema,
    )
    rows = conn.execute(sql, params).fetchall()
    return {
        "persons": [
            {
                "firstName": r[0],
                "middleName": r[1],
                "lastName": r[2],
                "nameSuffix": r[3],
                "addressLine1": r[4],
                "addressLine2": r[5],
                "city": r[6],
                "state": r[7],
                "zip5": r[8],
            }
            for r in rows
        ]
    }


class _PersonsCountByKeyRequest(_WireBaseModel):
    criteria: Criteria = Criteria()
    key_filter: KeyFilter | None = Field(default=None, validation_alias="keyFilter")
    key_group: str = Field(validation_alias="keyGroup")
    org_slug: str = Field(validation_alias="orgSlug")


@app.post("/persons/count-by-key")
async def persons_count_by_key(req: _PersonsCountByKeyRequest):
    """Per-key (per ED, per ZIP, …) aggregation of doors + people for a
    given criteria + optional spatial scope.

    Drives the zone editor's heatmap overlay and the campaign editor's
    boundary tinting. Response shape:
    ``{counts: {<key>: {doors, people}, ...}}``.
    """
    conn = get_connection(settings, read_only=True)
    version = resolve_version(conn, settings, req.org_slug)
    schema = version.schema
    catalog = build_field_catalog(version.manifest)
    group_expr = boundary_key_expr_for(catalog, req.key_group)
    criteria = resolve_criteria(req.criteria, conn, settings, req.org_slug)
    params: list = []
    where = criteria_to_where(catalog, criteria, req.key_filter, params)
    sql = resolve(
        f"""
        SELECT
            {group_expr} AS key,
            count(DISTINCT building_id) AS buildings,
            count(DISTINCT door_id) AS doors,
            count(*) AS people
        FROM {{persons_geocoded}}
        {where}
        GROUP BY {group_expr}
        """,
        schema,
    )
    rows = conn.execute(sql, params).fetchall()
    counts: dict[str, dict[str, int]] = {}
    for key, buildings, doors, people in rows:
        if key is None:
            continue
        counts[key] = {
            "buildings": int(buildings),
            "doors": int(doors),
            "people": int(people),
        }
    return {"counts": counts}


class _SegmentExportRequest(_WireBaseModel):
    criteria: Criteria = Criteria()
    org_slug: str = Field(validation_alias="orgSlug")
    format: str = "csv"


# The canonical Person fields — identity + geocodable address — present in every
# dataset regardless of importer. Dataset-specific columns are not exported.
_EXPORT_SELECT = """
    SELECT
        external_id,
        external_id_type,
        first_name,
        middle_name,
        last_name,
        name_suffix,
        address_line_1 AS address,
        address_line_2 AS unit,
        half_code,
        city,
        state,
        zip5 AS zip,
        zip4
    FROM {persons_geocoded}
"""


@app.post("/segments/export")
async def segments_export(req: _SegmentExportRequest):
    """Stream a segment's matched persons as CSV or Parquet.

    Resolves the criteria (same path as /persons/count), writes the canonical
    columns to a temp file via DuckDB COPY, and returns it as a download. A
    background task removes the temp file after the response is sent.
    `X-Export-Rows` carries the row count so the caller can log it.
    """
    if req.format not in ("csv", "parquet"):
        raise HTTPException(status_code=400, detail="format must be 'csv' or 'parquet'.")

    conn = get_connection(settings, read_only=True)
    version = resolve_version(conn, settings, req.org_slug)
    schema = version.schema
    catalog = build_field_catalog(version.manifest)
    criteria = resolve_criteria(req.criteria, conn, settings, req.org_slug)
    params: list = []
    where = criteria_to_where(catalog, criteria, None, params)
    select_sql = resolve(_EXPORT_SELECT + where, schema)

    suffix = ".parquet" if req.format == "parquet" else ".csv"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix="segment-export-")
    os.close(fd)
    # `tmp_path` is server-generated and the COPY options are from a fixed
    # allowlist, so the only untrusted input (criteria) stays in bound `params`.
    copy_opts = "FORMAT parquet" if req.format == "parquet" else "FORMAT csv, HEADER"
    copy_sql = f"COPY ({select_sql}) TO '{tmp_path}' ({copy_opts})"
    try:
        row = conn.execute(copy_sql, params).fetchone()
    except Exception:
        with suppress(OSError):
            os.remove(tmp_path)
        raise
    row_count = int(row[0]) if row else 0

    media = "application/octet-stream" if req.format == "parquet" else "text/csv"
    return FileResponse(
        tmp_path,
        media_type=media,
        filename=f"segment-export{suffix}",
        background=BackgroundTask(os.remove, tmp_path),
        headers={"X-Export-Rows": str(row_count)},
    )


class _BuildingsListRequest(_WireBaseModel):
    criteria: Criteria = Criteria()
    key_filter: KeyFilter | None = Field(default=None, validation_alias="keyFilter")
    org_slug: str = Field(validation_alias="orgSlug")


@app.post("/buildings/list")
async def buildings_list(req: _BuildingsListRequest):
    """One row per building containing at least one matching person,
    with door + person counts and the building's centroid.

    Used by the turf cutter to render buildings scoped to criteria ∩
    zone, with enough detail to compute "what's inside this drawn
    polygon" client-side.
    """
    conn = get_connection(settings, read_only=True)
    version = resolve_version(conn, settings, req.org_slug)
    schema = version.schema
    catalog = build_field_catalog(version.manifest)
    criteria = resolve_criteria(req.criteria, conn, settings, req.org_slug)
    params: list = []
    where = criteria_to_where(catalog, criteria, req.key_filter, params)
    sql = resolve(
        f"""
        SELECT
            b.building_id              AS "buildingId",
            b.longitude,
            b.latitude,
            count(DISTINCT fp.door_id) AS "doorCount",
            count(*)                   AS "personCount"
        FROM {{buildings_geocoded}} b
        JOIN (
            SELECT building_id, door_id FROM {{persons_geocoded}} {where}
        ) fp ON fp.building_id = b.building_id
        GROUP BY b.building_id, b.longitude, b.latitude
        """,
        schema,
    )
    cursor = conn.execute(sql, params)
    cols = [d[0] for d in cursor.description]
    rows = [dict(zip(cols, row, strict=True)) for row in cursor.fetchall()]
    return {"buildings": rows}


class _BuildingsPointsRequest(_WireBaseModel):
    criteria: Criteria = Criteria()
    key_filter: KeyFilter | None = Field(default=None, validation_alias="keyFilter")
    org_slug: str = Field(validation_alias="orgSlug")


@app.post("/buildings/points")
async def buildings_points(req: _BuildingsPointsRequest):
    """Binary mercator-delta pairs for buildings whose contained persons
    match the criteria.

    Wire format: 16-byte header of two fp64 (origin_x, origin_y in
    MapLibre [0,1] mercator), then N*8 bytes of fp32 (dx, dy) where each
    pair is the building's mercator coord minus the origin.

    The origin is the centroid of the returned points, kept at fp64 so
    the browser-side `cameraMerc - origin` subtraction stays precise.
    Storing deltas (not absolute mercator) lets fp32 spend its full
    mantissa on intra-cluster precision. Gives millimeter-scale at z20
    instead of meter-scale.
    """
    conn = get_connection(settings, read_only=True)
    version = resolve_version(conn, settings, req.org_slug)
    schema = version.schema
    catalog = build_field_catalog(version.manifest)
    criteria = resolve_criteria(req.criteria, conn, settings, req.org_slug)
    params: list = []
    where = criteria_to_where(catalog, criteria, req.key_filter, params)
    sql = resolve(
        f"""
        WITH pts AS (
            SELECT
                (b.longitude + 180.0) / 360.0 AS mx,
                0.5 - ln(tan(pi()/4 + radians(b.latitude)/2)) / (2*pi()) AS my
            FROM {{buildings_geocoded}} b
            WHERE b.building_id IN (
                SELECT DISTINCT building_id FROM {{persons_geocoded}} {where}
            )
        ),
        o AS (SELECT avg(mx) AS ox, avg(my) AS oy FROM pts)
        SELECT pts.mx - o.ox, pts.my - o.oy, o.ox, o.oy
        FROM pts, o
        """,
        schema,
    )
    cursor = conn.execute(sql, params)
    rows = cursor.fetchall()
    header = array.array("d", [0.0, 0.0])
    deltas = array.array("f")
    if rows:
        header[0] = rows[0][2]
        header[1] = rows[0][3]
        for dx, dy, _, _ in rows:
            deltas.append(dx)
            deltas.append(dy)
    return Response(
        content=header.tobytes() + deltas.tobytes(),
        media_type="application/octet-stream",
    )


@app.post("/turfs/publish")
async def turfs_publish(req: PublishTurfsRequest) -> dict[str, Any]:
    return await publish_turfs(req)
