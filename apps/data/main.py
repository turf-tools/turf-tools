from fastapi import FastAPI

app = FastAPI(title="Turf Data Service")


@app.get("/healthcheck")
async def healthcheck():
    return {"status": "ok"}
