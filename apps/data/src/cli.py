"""CLI entrypoints for the data package.
"""

import argparse
from pathlib import Path

from hamilton import driver

import duckdb
from src.dags import (
    aggregate,
    assembly,
    boundaries,
    geocode,
    matching,
    osm,
    quickwit,
    tiger,
)
from src.duckdb import get_connection
from src.models import quote_ident
from src.settings import get_settings
from src.tables import PERSON_CATALOG, schema_fqn
from src.tables import drop_schema as _drop_schema_helper


def _render(dr: driver.Driver, filename: str) -> None:
    docs = Path(__file__).resolve().parent.parent / "docs"
    docs.mkdir(exist_ok=True)
    path = str(docs / filename)
    dr.display_all_functions(path)
    print(f"Wrote {path}")


def update_visualizations() -> None:
    """Render all Hamilton graph visualizations into docs/.

    Importers (`src/importers/`) sit outside Hamilton, so the graphs start from
    `persons_validated`, which the shared pipeline takes as an input.
    """
    _render(driver.Builder().with_modules(tiger).build(), "tiger_graph.png")
    _render(driver.Builder().with_modules(matching).build(), "matching_graph.png")
    _render(driver.Builder().with_modules(osm).build(), "osm_graph.png")
    _render(driver.Builder().with_modules(geocode).build(), "geocode_graph.png")
    _render(driver.Builder().with_modules(assembly).build(), "assembly_graph.png")
    _render(driver.Builder().with_modules(aggregate).build(), "aggregate_graph.png")
    _render(driver.Builder().with_modules(quickwit).build(), "quickwit_graph.png")
    _render(driver.Builder().with_modules(boundaries).build(), "boundaries_graph.png")
    _render(
        driver.Builder().with_modules(tiger, osm, matching, geocode, assembly, aggregate, quickwit).build(),
        "pipeline_graph.png",
    )


def reset_ducklake(include_geo: bool = False) -> None:
    """Drop the DuckLake metadata catalog(s) in Postgres so a data reset stays
    consistent. The catalog lives in Postgres (not a local file), so deleting
    `local_data/` alone leaves it referencing removed Parquet — the next write
    then fails on a missing file. Dropping the metadata schema makes the next
    attach recreate it empty. Person catalog by default; `include_geo` also drops
    the TIGER/OSM reference catalog. No-op when a catalog isn't Postgres-backed."""
    settings = get_settings()
    targets = [(settings.ducklake_metadata_postgres_url, settings.ducklake_meta_schema)]
    if include_geo:
        targets.append((settings.ducklake_geo_metadata_postgres_url, settings.ducklake_geo_meta_schema))

    conn = duckdb.connect()
    conn.install_extension("postgres")
    conn.load_extension("postgres")
    try:
        for i, (url, schema) in enumerate(targets):
            if not url or not schema:
                continue
            alias = f"_reset_meta_{i}"
            conn.execute(f"ATTACH '{url}' AS {alias} (TYPE postgres)")
            conn.execute(f"CALL postgres_execute('{alias}', $ft$DROP SCHEMA IF EXISTS {schema} CASCADE$ft$)")
            conn.execute(f"DETACH {alias}")
            print(f"  → Dropped DuckLake metadata schema {schema!r}.")
    finally:
        conn.close()


def rename_schema() -> None:
    """Rename a DuckLake schema (``ducklake.<from>`` → ``ducklake.<to>``).

    Used when a dataset's slug changes so its version schemas stay addressable.
    No-op if the source schema doesn't exist.

        uv run rename-schema --from old-slug_v1 --to new-slug_v1
    """
    parser = argparse.ArgumentParser(prog="rename-schema", description=rename_schema.__doc__)
    parser.add_argument("--from", dest="src", required=True, help="Current schema name.")
    parser.add_argument("--to", dest="dst", required=True, help="New schema name.")
    args = parser.parse_args()

    if args.src == args.dst:
        print("--from and --to must differ.")
        return

    settings = get_settings()
    conn = get_connection(settings)

    src_exists = (
        conn.execute(
            "SELECT 1 FROM information_schema.schemata WHERE catalog_name = ? AND schema_name = ?",
            [PERSON_CATALOG, args.src],
        ).fetchone()
        is not None
    )
    if not src_exists:
        print(f"No schema {schema_fqn(args.src)} — nothing to rename.")
        conn.close()
        return

    conn.execute(f"ALTER SCHEMA {schema_fqn(args.src)} RENAME TO {quote_ident(args.dst)}")
    conn.close()
    print(f"Renamed schema: {args.src} → {args.dst}.")


def drop_schema() -> None:
    """Drop ``ducklake.<schema>`` and all tables in it (CASCADE). Idempotent.

    uv run drop-schema --schema nys_voter_file_v1
    """
    parser = argparse.ArgumentParser(prog="drop-schema", description=drop_schema.__doc__)
    parser.add_argument("--schema", required=True, help="Schema to drop.")
    args = parser.parse_args()

    settings = get_settings()
    conn = get_connection(settings)
    _drop_schema_helper(conn, args.schema)
    conn.close()
    print(f"Dropped schema {schema_fqn(args.schema)}.")
