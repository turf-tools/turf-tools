import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from db import create_tables, get_connection
from geocode import export_geojson, geocode_buildings
from import_voter_file import import_voter_file
from index_quickwit import clear_index, run_index, run_search
from settings import get_settings
from turf.storage import read_turf_data

logger = logging.getLogger("uvicorn")

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    conn = get_connection(settings)
    create_tables(conn)
    conn.close()
    logger.info("DuckLake tables ready.")
    yield


app = FastAPI(title="Data Service", lifespan=lifespan)


class ImportRequest(BaseModel):
    file_path: str
    voter_file_id: str = "nys_boe"


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


@app.post("/voter-file/import")
async def voter_file_import(request: ImportRequest):
    conn = get_connection(settings)
    try:
        result = import_voter_file(conn, request.file_path, request.voter_file_id)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    finally:
        conn.close()


@app.get("/voter-file/{voter_file_id}/versions")
async def voter_file_versions(voter_file_id: str):
    conn = get_connection(settings)
    versions = conn.execute(
        """
        SELECT voter_file_version, count(*) as voter_count
        FROM voter_file
        WHERE voter_file_id = ?
        GROUP BY voter_file_version
        ORDER BY voter_file_version
        """,
        [voter_file_id],
    ).fetchall()
    conn.close()
    return {
        "voter_file_id": voter_file_id,
        "versions": [{"version": v[0], "voter_count": v[1]} for v in versions],
    }


@app.post("/buildings/geocode")
async def buildings_geocode():
    conn = get_connection(settings)
    try:
        result = geocode_buildings(conn)
        return result
    finally:
        conn.close()


@app.get("/buildings/geojson")
async def buildings_geojson():
    conn = get_connection(settings)
    try:
        return export_geojson(conn, "buildings")
    finally:
        conn.close()


@app.get("/doors/geojson")
async def doors_geojson():
    conn = get_connection(settings)
    try:
        return export_geojson(conn, "doors")
    finally:
        conn.close()


@app.get("/persons/geojson")
async def persons_geojson():
    conn = get_connection(settings)
    try:
        return export_geojson(conn, "voter_file")
    finally:
        conn.close()


@app.post("/persons/index")
async def persons_index():
    conn = get_connection(settings)
    try:
        result = run_index(conn)
        return result
    finally:
        conn.close()


@app.post("/persons/reindex")
async def persons_reindex():
    clear_index()
    conn = get_connection(settings)
    try:
        result = run_index(conn)
        return result
    finally:
        conn.close()


@app.get("/persons/search")
async def persons_search(q: str, limit: int = 20):
    return run_search(q, limit=limit)


@app.get("/turfs/{turf_id}/data")
async def turfs_get_data(turf_id: str):
    """Serve a turf data blob from storage."""
    try:
        return read_turf_data(settings, turf_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
