import array
import logging
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from src.db import get_connection
from src.settings import get_settings

logger = logging.getLogger("uvicorn")

settings = get_settings()

# Read-side HTTP surface for the data service. Heavy work — voter-file
# loading, geocoding, Quickwit indexing — runs as Hamilton DAGs via CLI
# jobs. This service exposes health, a boundary-GeoJSON fetch, and a
# generic `/query` endpoint that the web RPC layer calls into.
app = FastAPI(title="Data Service")

# Permissive CORS for dev — the web app fetches boundary GeoJSON
# directly from here and POSTs to `/query`. Lock down via a
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


class _ExecuteRequest(BaseModel):
    sql: str
    params: list[Any] = []


@app.post("/query")
async def query(req: _ExecuteRequest, request: Request):
    """Run a parameterised DuckDB query, return JSON or binary.

    The web layer owns the segment-query DSL and emits the SQL passed
    in here. Output format follows the caller's ``Accept`` header:

    - ``application/json`` (default) → ``{rows: [{col: value, ...}]}``
      with STRUCT/ARRAY columns deserialised to nested dicts/lists.
      Used for counts, samples, per-zone aggregation — anything whose
      result is naturally JSON-shaped.

    - ``application/octet-stream`` → raw Float32 bytes in row-major
      order (col0row0, col1row0, col0row1, ...). Designed for SQL like
      ``SELECT longitude, latitude FROM ...`` that streams directly
      into a Float32Array on the browser, then into a GPU buffer with
      no per-byte decode work. Servers and browsers are all
      little-endian in practice, so we skip an explicit byteswap.

    Connections open ``read_only=True`` so a misrouted call can't
    mutate the lake — Hamilton DAGs (run as CLI jobs) are the only
    writers.
    """
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
