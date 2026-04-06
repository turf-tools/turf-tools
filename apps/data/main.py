import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from db import create_tables, get_connection
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
