"""Carry raw tables from the version an Update builds on.

A source whose `on_update` is `keep` reuses the base version's table when left
blank; one that's `add` gains the base version's rows on top of what was read.
Each version holds its own copy, so a version never reads another after import.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from src.importers.base import SourceUnreadableError
from src.tables import PERSON_CATALOG, table_fqn

if TYPE_CHECKING:
    from collections.abc import Mapping

    import duckdb
    from src.importers.base import Importer, SourceSpec


def carried_tables(importer: type[Importer] | Importer) -> frozenset[str]:
    """The raw tables the importer's `keep` and `add` sources fill, which every
    version keeps for the next Update."""
    return frozenset(s.table for s in importer.SOURCES if s.on_update != "replace" and s.table)


def carry_forward(
    importer: type[Importer] | Importer,
    sources: Mapping[str, str],
    schema: str,
    base_schema: str | None,
    conn: duckdb.DuckDBPyConnection,
    keep_only: str | None = None,
) -> None:
    """Fill the `keep` and `add` sources' tables in `schema` from `base_schema`,
    after the importer has read whatever was supplied. `keep_only`, a condition
    over the table aliased `raw`, is the dataset's import filter: a kept table
    stores only the rows it selects."""
    for spec in importer.SOURCES:
        if spec.on_update == "replace" or spec.table is None:
            continue
        table = table_fqn(schema, spec.table)
        supplied = bool(sources.get(spec.key, "").strip())
        if base_schema is not None and (spec.on_update == "add" or not supplied):
            base = _base_table(conn, base_schema, spec)
            if spec.on_update == "keep":
                conn.execute(f"CREATE OR REPLACE TABLE {table} AS SELECT * FROM {base}")
            else:
                conn.execute(f"INSERT INTO {table} BY NAME (SELECT * FROM {base} EXCEPT SELECT * FROM {table})")
        if spec.on_update == "keep" and keep_only is not None:
            conn.execute(f"DELETE FROM {table} AS raw WHERE ({keep_only}) IS NOT TRUE")


def _base_table(conn: duckdb.DuckDBPyConnection, base_schema: str, spec: SourceSpec) -> str:
    """The base version's copy of `spec`'s table; fails readably when it has none."""
    assert spec.table is not None
    found = conn.execute(
        "SELECT count(*) FROM duckdb_tables() WHERE database_name = ? AND schema_name = ? AND table_name = ?",
        [PERSON_CATALOG, base_schema, spec.table],
    ).fetchone()
    if not found or not found[0]:
        raise SourceUnreadableError(
            f"The version this update builds on has no stored {spec.label.lower()}. Supply the {spec.label.lower()}."
        )
    return table_fqn(base_schema, spec.table)
