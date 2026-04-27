import array
import json
import logging
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from src.db import get_connection
from src.settings import get_settings

logger = logging.getLogger("uvicorn")

settings = get_settings()

# Minimal HTTP surface. The person-loading / geocoding / Quickwit-indexing
# pipelines are Hamilton DAGs, not HTTP endpoints. This service currently
# only exposes health + a turf-blob fetch. New endpoints for the admin UI
# (list_buildings / list_persons / zone-scoped cuts) will land here.
app = FastAPI(title="Data Service")

# Permissive CORS for dev — the web app (apps/web at :3000) fetches static
# blobs (boundary GeoJSON, turf data) directly from this service. Native
# and server-to-server callers aren't affected by CORS either way. Lock
# this down via a settings-driven allow list when we deploy.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

LOCAL_TURFS_DIR = Path("local_turfs")


@app.get("/healthcheck")
async def healthcheck():
    return {"status": "ok"}


@app.get("/ducklake/status")
async def ducklake_status():
    conn = get_connection(settings)
    tables = conn.execute("SHOW TABLES").fetchall()
    table_info = {}
    for (table_name,) in tables:
        columns = conn.execute(f"DESCRIBE {table_name}").fetchall()
        table_info[table_name] = [{"name": col[0], "type": col[1]} for col in columns]
    conn.close()
    return {
        "status": "ok",
        "tables": table_info,
    }


@app.get("/turfs/{turf_id}/data")
async def turfs_get_data(turf_id: str):
    """Serve a turf data blob from local storage.

    S3-backed storage will land alongside the new turf-writer endpoint.
    """
    path = LOCAL_TURFS_DIR / f"{turf_id}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Turf data not found for turf_id={turf_id}")
    return json.loads(path.read_text())


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
    conn = get_connection(settings)
    try:
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
    finally:
        conn.close()

    return Response(
        content=body,
        media_type="application/geo+json",
        headers={
            # Effectively forever; bust by versioning the URL when contents change.
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


# ---------------------------------------------------------------------------
# Generic SQL execute endpoint.
#
# The web layer owns the segment-query DSL and emits parameterised
# DuckDB SQL. This endpoint is the only thing the service does at
# request time: prepared-statement execute, JSON or binary out
# depending on the caller's `Accept` header.
#
# - `Accept: application/json` (default) → `{rows: [{col: value, ...}]}`
#   with STRUCT/ARRAY columns deserialised to nested dicts/lists. Used
#   by the segment editor for counts, samples, per-zone aggregation,
#   stats summaries — anything whose result is naturally JSON-shaped.
#
# - `Accept: application/octet-stream` → raw Float32 bytes in row-major
#   order (col0row0, col1row0, col0row1, ...). Designed for SQL like
#   `SELECT longitude, latitude FROM ...` that streams directly into a
#   Float32Array on the browser, then into a GPU buffer with no
#   per-byte decode work. Servers and browsers in practice are all
#   little-endian, so we skip an explicit byteswap.
#
# Connections are opened ``read_only=True`` so a bug or misrouted call
# physically cannot mutate the lake — the Hamilton ingestion DAGs are
# the only writers, and they run as CLI jobs.
# ---------------------------------------------------------------------------


class _ExecuteRequest(BaseModel):
    sql: str
    params: list[Any] = []


@app.post("/query")
async def query(req: _ExecuteRequest, request: Request):
    binary = request.headers.get("accept", "").lower() == "application/octet-stream"
    conn = get_connection(settings, read_only=True)
    try:
        cursor = conn.execute(req.sql, req.params)
        if binary:
            arr = array.array("f")
            for row in cursor.fetchall():
                for v in row:
                    arr.append(v)
            return Response(content=arr.tobytes(), media_type="application/octet-stream")
        cols = [desc[0] for desc in cursor.description]
        rows = [dict(zip(cols, row, strict=True)) for row in cursor.fetchall()]
    finally:
        conn.close()
    return {"rows": rows}
