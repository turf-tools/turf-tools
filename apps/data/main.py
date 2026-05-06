import array
import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from typing import Any

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from src.abstract_tables import resolve
from src.dsl.compile import boundary_key_expr_for, to_where
from src.dsl.criteria import Criteria, KeyFilter
from src.duckdb import get_connection
from src.job_runner import JobManager
from src.publish_turfs import PublishTurfsRequest, publish_turfs
from src.settings import get_settings

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
        logger.exception("Job manager stopped unexpectedly", exc_info=exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
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

    try:
        yield
    finally:
        job_manager_task.cancel()
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
async def key_group_geojson(key_group: str):
    """Serve all polygons for a key group as a GeoJSON FeatureCollection.

    Reads from ``geo_ducklake.boundaries.{key_group}`` (populated by the
    `seed-boundaries` CLI). Polygons are pre-simplified at load time, so the
    response is sized for map rendering rather than raw fidelity.

    Cached aggressively — boundary tables are static reference data that
    only changes when an admin re-seeds them. When that happens, append a
    bumped `?v=` query param at the call site to bust browser caches.
    """
    conn = get_connection(settings, read_only=True)
    # Validate the table exists before querying — keeps the error message
    # friendlier than a generic SQL failure.
    fqn = f"geo_ducklake.boundaries.{key_group}"
    try:
        conn.execute(f"SELECT 1 FROM {fqn} LIMIT 0")
    except Exception as e:
        raise HTTPException(
            status_code=404,
            detail=f"No boundary table for key_group={key_group}. Run `uv run seed-boundaries`.",
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


class _PersonsCountRequest(BaseModel):
    criteria: Criteria = Criteria()
    keyFilter: KeyFilter | None = None  # noqa: N815  -- camelCase matches wire format from web
    orgSlug: str  # noqa: N815


@app.post("/persons/count")
async def persons_count(req: _PersonsCountRequest):
    """Persons-level summary counts.

    Response shape: ``{personCount, doorCount, buildingCount}``.

    Aggregates only — no row-level data. DuckDB's column pruning means
    we only read `door_id`, `building_id`, and the columns referenced by
    the WHERE clause; orders of magnitude less I/O than materialising
    every column. Row-level previews live at ``/persons/sample``.
    """
    where, params = to_where(req.criteria, req.keyFilter)
    # CTE materialised once so the WHERE evaluates a single time even
    # though three subqueries reference it.
    sql = resolve(
        f"""
        SELECT
            count(*) AS "personCount",
            count(DISTINCT door_id) AS "doorCount",
            count(DISTINCT building_id) AS "buildingCount"
        FROM {{persons_geocoded}}
        {where}
        """,
        slug=req.orgSlug,
    )
    conn = get_connection(settings, read_only=True)
    row = conn.execute(sql, params).fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="Persons count query returned no rows.")
    return {
        "personCount": row[0],
        "doorCount": row[1],
        "buildingCount": row[2],
    }


class _PersonsSampleRequest(BaseModel):
    criteria: Criteria = Criteria()
    keyFilter: KeyFilter | None = None  # noqa: N815
    orgSlug: str  # noqa: N815
    limit: int = 100


@app.post("/persons/sample")
async def persons_sample(req: _PersonsSampleRequest):
    """Row-level sample of people matching the criteria.

    Response shape: ``{persons: [{firstName, lastName, addressLine1,
    addressLine2, city, state, zip5}, ...]}``. Used by the segment
    editor's list-view preview. Capped at ``limit`` (default 100).
    """
    where, params = to_where(req.criteria, req.keyFilter)
    limit = max(1, min(req.limit, 500))
    # Random sample so the preview doesn't keep showing the same physical-order
    # rows as filters change. Sample sits outside the filter subquery so the
    # WHERE applies first, then we draw N rows from the matched set.
    sql = resolve(
        f"""
        SELECT * FROM (
            SELECT
                first_name,
                last_name,
                address_line_1,
                address_line_2,
                city,
                state,
                zip5
            FROM {{persons_geocoded}}
            {where}
        ) USING SAMPLE {limit} ROWS
        """,
        slug=req.orgSlug,
    )
    conn = get_connection(settings, read_only=True)
    rows = conn.execute(sql, params).fetchall()
    return {
        "persons": [
            {
                "firstName": r[0],
                "lastName": r[1],
                "addressLine1": r[2],
                "addressLine2": r[3],
                "city": r[4],
                "state": r[5],
                "zip5": r[6],
            }
            for r in rows
        ]
    }


class _PersonsCountByKeyRequest(BaseModel):
    criteria: Criteria = Criteria()
    keyFilter: KeyFilter | None = None  # noqa: N815
    keyGroup: str  # noqa: N815
    orgSlug: str  # noqa: N815


@app.post("/persons/count-by-key")
async def persons_count_by_key(req: _PersonsCountByKeyRequest):
    """Per-key (per ED, per ZIP, …) aggregation of doors + people for a
    given criteria + optional spatial scope.

    Drives the zone editor's heatmap overlay and the campaign editor's
    boundary tinting. Response shape:
    ``{counts: {<key>: {doors, people}, ...}}``.
    """
    where, params = to_where(req.criteria, req.keyFilter)
    group_expr = boundary_key_expr_for(req.keyGroup)
    sql = resolve(
        f"""
        SELECT
            {group_expr} AS key,
            count(DISTINCT door_id) AS doors,
            count(*) AS people
        FROM {{persons_geocoded}}
        {where}
        GROUP BY {group_expr}
        """,
        slug=req.orgSlug,
    )
    conn = get_connection(settings, read_only=True)
    rows = conn.execute(sql, params).fetchall()
    counts: dict[str, dict[str, int]] = {}
    for key, doors, people in rows:
        if key is None:
            continue
        counts[key] = {"doors": int(doors), "people": int(people)}
    return {"counts": counts}


class _BuildingsListRequest(BaseModel):
    criteria: Criteria = Criteria()
    keyFilter: KeyFilter | None = None  # noqa: N815
    orgSlug: str  # noqa: N815


@app.post("/buildings/list")
async def buildings_list(req: _BuildingsListRequest):
    """One row per building containing at least one matching person,
    with door + person counts and the building's centroid.

    The persons-side WHERE lives in a subquery so its unqualified
    column references (e.g. `zip5`) only see persons — without the
    subquery, columns shared between persons and buildings would be
    ambiguous in the outer JOIN.

    Used by the turf cutter to render buildings scoped to criteria ∩
    zone, with enough detail to compute "what's inside this drawn
    polygon" client-side.
    """
    where, params = to_where(req.criteria, req.keyFilter)
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
        ) fp
            ON fp.building_id = b.building_id
        GROUP BY b.building_id, b.longitude, b.latitude
        """,
        slug=req.orgSlug,
    )
    conn = get_connection(settings, read_only=True)
    cursor = conn.execute(sql, params)
    cols = [d[0] for d in cursor.description]
    rows = [dict(zip(cols, row, strict=True)) for row in cursor.fetchall()]
    return {"buildings": rows}


class _BuildingsPointsRequest(BaseModel):
    criteria: Criteria = Criteria()
    keyFilter: KeyFilter | None = None  # noqa: N815
    orgSlug: str  # noqa: N815


@app.post("/buildings/points")
async def buildings_points(req: _BuildingsPointsRequest):
    """Binary lng/lat pairs (Float32, row-major) for buildings whose
    contained persons match the criteria.

    The persons-side WHERE goes through a `WHERE building_id IN (SELECT
    DISTINCT building_id FROM persons ...)` subquery so unqualified
    column refs only see persons. Empty criteria → all buildings with
    at least one matched person.

    Designed for direct upload into a GPU buffer on the browser — no
    JSON envelope, no per-byte decode work.
    """
    where, params = to_where(req.criteria, req.keyFilter)
    sql = resolve(
        f"""
        SELECT longitude, latitude
        FROM {{buildings_geocoded}}
        WHERE building_id IN (
          SELECT DISTINCT building_id FROM {{persons_geocoded}} {where}
        )
        """,
        slug=req.orgSlug,
    )
    conn = get_connection(settings, read_only=True)
    cursor = conn.execute(sql, params)
    arr = array.array("f")
    for lng, lat in cursor.fetchall():
        arr.append(lng)
        arr.append(lat)
    return Response(content=arr.tobytes(), media_type="application/octet-stream")


@app.post("/turfs/publish")
async def turfs_publish(req: PublishTurfsRequest) -> dict[str, Any]:
    return await publish_turfs(req)
