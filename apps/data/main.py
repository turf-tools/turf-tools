import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from db import create_tables, get_connection
from import_voter_file import import_voter_file
from settings import get_settings

logger = logging.getLogger("uvicorn")

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    conn = get_connection(settings)
    create_tables(conn)
    conn.close()
    logger.info("DuckLake tables ready.")
    yield


app = FastAPI(title="Turf Data Service", lifespan=lifespan)


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


class ImportRequest(BaseModel):
    file_path: str
    voter_file_id: str = "nys_boe"


@app.post("/voter-file/import")
async def import_voter_file_endpoint(request: ImportRequest):
    conn = get_connection(settings)
    try:
        result = import_voter_file(conn, request.file_path, request.voter_file_id)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    finally:
        conn.close()


@app.get("/voter-file/{voter_file_id}/versions")
async def list_versions(voter_file_id: str):
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
