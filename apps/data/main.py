import json
import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException

from src.db import get_connection
from src.settings import get_settings

logger = logging.getLogger("uvicorn")

settings = get_settings()

# Minimal HTTP surface. The person-loading / geocoding / Quickwit-indexing
# pipelines are Hamilton DAGs, not HTTP endpoints. This service currently
# only exposes health + a turf-blob fetch. New endpoints for the admin UI
# (list_buildings / list_persons / zone-scoped cuts) will land here.
app = FastAPI(title="Data Service")

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
