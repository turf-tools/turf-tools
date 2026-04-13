import json
import logging
from pathlib import Path

import duckdb
import requests

logger = logging.getLogger("uvicorn")

QUICKWIT_URL = "http://localhost:7280"
INDEX_CONFIG_PATH = Path(__file__).parent / "quickwit" / "persons.yaml"


def ensure_index(quickwit_url: str = QUICKWIT_URL) -> None:
    """Create the persons index if it doesn't exist."""
    resp = requests.get(f"{quickwit_url}/api/v1/indexes/persons", timeout=5)
    if resp.status_code == 200:
        return  # already exists

    with open(INDEX_CONFIG_PATH) as f:
        config = f.read()

    resp = requests.post(
        f"{quickwit_url}/api/v1/indexes",
        headers={"Content-Type": "application/yaml"},
        data=config,
        timeout=10,
    )
    resp.raise_for_status()
    logger.info("Created Quickwit 'persons' index.")


def run_index(
    conn: duckdb.DuckDBPyConnection,
    voter_file_id: str | None = None,
    voter_file_version: int | None = None,
    quickwit_url: str = QUICKWIT_URL,
) -> dict:
    """Export voter records from DuckLake and ingest into Quickwit.

    If voter_file_id/version are specified, only index those records.
    Otherwise, indexes all records.
    """
    ensure_index(quickwit_url)

    where_clauses = []
    params = []
    if voter_file_id:
        where_clauses.append("voter_file_id = ?")
        params.append(voter_file_id)
    if voter_file_version is not None:
        where_clauses.append("voter_file_version = ?")
        params.append(voter_file_version)

    where = "WHERE " + " AND ".join(where_clauses) if where_clauses else ""

    rows = conn.execute(
        f"""
        SELECT
            voter_id, voter_file_id, voter_file_version,
            first_name, last_name,
            house_number, street_name, unit,
            city, state, zip, party
        FROM voter_file
        {where}
        """,
        params,
    ).fetchall()

    if not rows:
        return {"indexed": 0}

    columns = [
        "voter_id",
        "voter_file_id",
        "voter_file_version",
        "first_name",
        "last_name",
        "house_number",
        "street_name",
        "unit",
        "city",
        "state",
        "zip",
        "party",
    ]

    # Build NDJSON and send in chunks
    total_indexed = 0
    chunk_size = 5000
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i : i + chunk_size]
        ndjson = "\n".join(json.dumps(dict(zip(columns, row, strict=True)), default=str) for row in chunk)
        resp = requests.post(
            f"{quickwit_url}/api/v1/persons/ingest?commit=force",
            headers={"Content-Type": "application/json"},
            data=ndjson,
            timeout=60,
        )
        resp.raise_for_status()
        total_indexed += len(chunk)

    logger.info("Indexed %d voter records into Quickwit.", total_indexed)
    return {"indexed": total_indexed}


def clear_index(quickwit_url: str = QUICKWIT_URL) -> None:
    """Delete and recreate the persons index."""
    requests.delete(f"{quickwit_url}/api/v1/indexes/persons", timeout=10)
    ensure_index(quickwit_url)
    logger.info("Cleared and recreated Quickwit 'persons' index.")


def run_search(query: str, limit: int = 20, quickwit_url: str = QUICKWIT_URL) -> dict:
    """Search voters via Quickwit."""
    resp = requests.post(
        f"{quickwit_url}/api/v1/persons/search",
        headers={"Content-Type": "application/json"},
        json={"query": query, "max_hits": limit},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()

    return {
        "total": data.get("num_hits", 0),
        "hits": [hit.get("doc", hit) for hit in data.get("hits", [])],
    }
