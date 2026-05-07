"""asyncpg pool for the operational Postgres.

Single shared pool per process, created lazily on first use and closed at
shutdown by the FastAPI lifespan.

For heavy cross-database operations (DuckLake + Postgres in one
transaction), prefer DuckDB's `postgres` extension via `ATTACH` instead.
This pool is for single-point reads and small writes.
"""

from __future__ import annotations

from typing import Any

import asyncpg

from src.settings import get_settings

_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    """Return the process-wide asyncpg pool, creating it on first call."""
    global _pool
    if _pool is None:
        url = get_settings().database_url
        if not url:
            raise RuntimeError("DATABASE_URL is required.")
        _pool = await asyncpg.create_pool(url, min_size=1, max_size=10)
    return _pool


async def close_pool() -> None:
    """Close the pool. Idempotent."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def fetch(query: str, *args: Any) -> list[asyncpg.Record]:
    """Run a SELECT and return all rows."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        return await conn.fetch(query, *args)


async def fetchrow(query: str, *args: Any) -> asyncpg.Record | None:
    """Run a SELECT and return the first row (or None)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchrow(query, *args)


async def execute(query: str, *args: Any) -> str:
    """Run a non-returning statement (INSERT/UPDATE/DELETE/DDL)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        return await conn.execute(query, *args)
