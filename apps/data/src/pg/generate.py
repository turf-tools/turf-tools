import argparse
import asyncio
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

import black
from piccolo.apps.schema.commands.generate import get_output_schema

OUTPUT_PATH = Path(__file__).with_name("tables.py")


async def check_asyncpg_connection() -> None:
    print("Checking asyncpg connection...", flush=True)
    print("Importing asyncpg...", flush=True)
    import asyncpg

    print("asyncpg imported.", flush=True)
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required for Postgres schema generation.")

    parsed = urlparse(database_url)
    config = {
        "database": parsed.path.removeprefix("/"),
        "user": parsed.username,
        "password": parsed.password,
        "host": parsed.hostname,
        "port": parsed.port or 5432,
    }
    print(
        f"Connecting to {config.get('host')}:{config.get('port')}/{config.get('database')}...",
        flush=True,
    )
    conn = await asyncio.wait_for(asyncpg.connect(**config, timeout=5), timeout=10)
    try:
        await asyncio.wait_for(conn.fetchval("SELECT 1"), timeout=5)
    finally:
        await conn.close()
    print("asyncpg connection OK.", flush=True)


async def generate_tables(schema_name: str = "public") -> None:
    await check_asyncpg_connection()
    print(f"Generating Piccolo tables from Postgres schema `{schema_name}`...", flush=True)
    output_schema = await get_output_schema(schema_name=schema_name)
    print(f"Found {len(output_schema.tables)} tables.", flush=True)
    output = output_schema.imports + [table._table_str(excluded_params=["choices"]) for table in output_schema.tables]

    if output_schema.warnings:
        output.extend(
            [
                '"""',
                "WARNING: Unrecognised column types, added `Column` as a placeholder:",
                "\n".join(output_schema.warnings),
                '"""',
            ]
        )

    if output_schema.index_warnings:
        output.extend(
            [
                '"""',
                "WARNING: Unable to parse the following indexes:",
                "\n".join(set(output_schema.index_warnings)),
                '"""',
            ]
        )

    if output_schema.trigger_warnings:
        output.extend(
            [
                '"""',
                "WARNING: Unable to find triggers for the following (used for ON UPDATE, ON DELETE):",
                "\n".join(set(output_schema.trigger_warnings)),
                '"""',
            ]
        )

    OUTPUT_PATH.write_text(
        black.format_str("\n".join(output), mode=black.FileMode(line_length=120)),
    )
    print(f"Wrote {OUTPUT_PATH}", flush=True)


def main() -> None:
    print("Starting Postgres schema generation.", flush=True)
    parser = argparse.ArgumentParser(description="Generate Piccolo tables from the operational Postgres schema.")
    parser.add_argument("--schema-name", default="public")
    args = parser.parse_args()

    try:
        asyncio.run(generate_tables(schema_name=args.schema_name))
    except Exception as error:
        print(error, flush=True)
        raise
    sys.exit(0)


if __name__ == "__main__":
    main()
