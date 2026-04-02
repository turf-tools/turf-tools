from fastapi import FastAPI

from db import get_connection

app = FastAPI(title="Turf Data Service")


@app.get("/healthcheck")
async def healthcheck():
    return {"status": "ok"}


@app.get("/ducklake/status")
async def ducklake_status():
    conn = get_connection()
    tables = conn.execute("SHOW TABLES").fetchall()
    conn.close()
    return {
        "status": "ok",
        "tables": [t[0] for t in tables],
    }
