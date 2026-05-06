import array
import json
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from src.abstract_tables import resolve
from src.db import get_connection
from src.dsl.compile import boundary_key_expr_for, to_where
from src.dsl.criteria import Criteria, KeyFilter
from src.settings import get_settings

logger = logging.getLogger("uvicorn")

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm the shared connection's buffer pool so the first user request
    # doesn't pay cold S3 round-trips for Parquet footers + page reads.
    try:
        conn = get_connection(settings, read_only=True)
        tables = conn.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_catalog = 'ducklake' AND table_name LIKE '%_persons_geocoded'"
        ).fetchall()
        for (table,) in tables:
            conn.execute(f'SELECT count(DISTINCT door_id), count(DISTINCT building_id) FROM "{table}"').fetchone()
        logger.info("Warmup completed")
    except Exception:
        logger.exception("Warmup failed; continuing")
    yield


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
    every column. A separate sample endpoint can be added when a stats
    view needs row-level previews.
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
    return {
        "personCount": row[0],
        "doorCount": row[1],
        "buildingCount": row[2],
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


class _TurfDraftInput(BaseModel):
    name: str | None
    sortOrder: int  # noqa: N815
    geometry: dict[str, Any]


class _TurfsBuildRequest(BaseModel):
    drafts: list[_TurfDraftInput]
    criteria: Criteria = Criteria()
    keyFilter: KeyFilter | None = None  # noqa: N815
    orgSlug: str  # noqa: N815


@app.post("/turfs/build")
async def turfs_build(req: _TurfsBuildRequest):
    """Spatial-join publish step — builds the structured per-turf
    payload web inserts into Postgres.

    For each input draft polygon, returns a `buildings → doors →
    persons` tree of every matched-person whose building's centroid
    falls inside that polygon (first-match-wins on overlaps, ordered
    by `sortOrder`). Per-turf door + person counts are pre-aggregated.
    Buildings outside every polygon are dropped.

    Heavy work — single SQL pass over filtered persons + spatial join
    against the polygon set, then in-memory grouping. Lives here
    because it needs to scale to large publishes (autocut, batch
    operations) and benefit from job-runner orchestration when those
    arrive.
    """
    if not req.drafts:
        return {"turfs": []}

    where_sql, where_params = to_where(req.criteria, req.keyFilter)

    # Polygons CTE built from the request — one row per draft, indexed
    # by position so we can echo back results in the same order.
    polygon_rows = ", ".join(f"({i}, ST_GeomFromGeoJSON(?))" for i in range(len(req.drafts)))
    polygon_params = [json.dumps(d.geometry) for d in req.drafts]

    # TODO - bring all JSON construction into DuckDB
    # CTE should go with polygons, with filtered_persons, with turfs, and then insert
    # The turfs directly into the attached postgres
    # Turf ID generation should migrate to a database default function
    sql = resolve(
        f"""
        WITH polygons(idx, geom) AS (VALUES {polygon_rows}),
        filtered_persons AS (
            SELECT * FROM {{persons_geocoded}} {where_sql}
        )
        SELECT
            assignment.polygon_idx,
            p.external_id,
            p.first_name,
            p.last_name,
            p.address_line_2 AS unit,
            p.other_properties,
            p.building_id,
            p.door_id,
            b.latitude,
            b.longitude,
            b.address_line_1 AS street,
            b.city,
            b.state,
            b.zip5 AS zip
        FROM filtered_persons p
        JOIN {{buildings_geocoded}} b ON b.building_id = p.building_id
        JOIN LATERAL (
            SELECT MIN(po.idx) AS polygon_idx
            FROM polygons po
            WHERE ST_Contains(po.geom, ST_Point(b.longitude, b.latitude))
        ) assignment ON assignment.polygon_idx IS NOT NULL
        """,
        slug=req.orgSlug,
    )

    conn = get_connection(settings, read_only=True)
    rows = conn.execute(sql, polygon_params + where_params).fetchall()

    # Group rows: polygon_idx → building_id → door_id → [persons].
    # Building canonical fields (lat/lng, address) repeat across every
    # row sharing a building_id; first occurrence wins.
    per_polygon: list[dict[str, Any]] = [{"buildings": {}} for _ in req.drafts]
    for row in rows:
        (
            polygon_idx,
            external_id,
            first_name,
            last_name,
            unit,
            other_properties,
            building_id,
            door_id,
            latitude,
            longitude,
            street,
            city,
            state,
            zip_,
        ) = row

        bucket = per_polygon[polygon_idx]
        building = bucket["buildings"].get(building_id)
        if building is None:
            building = {
                "buildingId": building_id,
                "latitude": latitude,
                "longitude": longitude,
                "address": {"street": street, "city": city, "state": state, "zip": zip_},
                "doors": {},
            }
            bucket["buildings"][building_id] = building

        door = building["doors"].get(door_id)
        if door is None:
            door = {"doorId": door_id, "unit": unit, "persons": []}
            building["doors"][door_id] = door

        # `other_properties` arrives as either a JSON string or a
        # parsed dict depending on column shape — coerce to dict.
        other_props = json.loads(other_properties) if isinstance(other_properties, str) else other_properties or {}

        door["persons"].append(
            {
                "personId": external_id,
                "firstName": first_name,
                "lastName": last_name,
                "otherProperties": other_props,
            }
        )

    # Materialize the per-turf payloads in input order, flattening the
    # building/door dicts to lists. Empty polygons (no matched
    # buildings) come through with `buildings: []`.
    out_turfs: list[dict[str, Any]] = []
    for draft, bucket in zip(req.drafts, per_polygon, strict=True):
        buildings_out = []
        door_count = 0
        person_count = 0
        for b in bucket["buildings"].values():
            doors_out = []
            for d in b["doors"].values():
                doors_out.append(d)
                door_count += 1
                person_count += len(d["persons"])
            buildings_out.append(
                {
                    "buildingId": b["buildingId"],
                    "latitude": b["latitude"],
                    "longitude": b["longitude"],
                    "address": b["address"],
                    "doors": doors_out,
                }
            )
        out_turfs.append(
            {
                "name": draft.name,
                "sortOrder": draft.sortOrder,
                "geometry": draft.geometry,
                "doorCount": door_count,
                "personCount": person_count,
                "buildings": buildings_out,
            }
        )

    return {"turfs": out_turfs}
