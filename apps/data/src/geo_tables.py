"""Per-state storage for derived reference tables in `ducklake_geo`.

`blockface_final`, `blockface_relationships`, and `osm.building_lookup` are
derived from per-county TIGER and per-state OSM data and rebuilt by every
import that touches a state. Each holds a `state_fips` column and an import
replaces only its own states' rows, so a deployment's other states are never
read, rebuilt, or held in memory.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import duckdb

if TYPE_CHECKING:
    from src.models import GeoExtent


def states_to_build(conn: duckdb.DuckDBPyConnection, source_fqn: str, geo_extent: GeoExtent | None) -> list[str]:
    """The import's states, or every state in `source_fqn` when there's no extent
    (a direct call outside an import)."""
    if geo_extent is not None:
        return list(geo_extent.states)
    return [r[0] for r in conn.execute(f"SELECT DISTINCT state_fips FROM {source_fqn} ORDER BY 1").fetchall()]


def replace_state_rows(conn: duckdb.DuckDBPyConnection, fqn: str, state: str, select_sql: str) -> None:
    """Replace `state`'s rows of `fqn` with `select_sql`'s, which must carry a
    `state_fips` column. One transaction, so a concurrent reader sees the old
    rows or the new, never neither. The first build creates the table."""
    try:
        conn.execute(f"DESCRIBE {fqn}")
    except duckdb.CatalogException:
        conn.execute(f"CREATE TABLE {fqn} AS {select_sql}")
        return
    conn.execute("BEGIN TRANSACTION")
    try:
        conn.execute(f"DELETE FROM {fqn} WHERE state_fips = ?", [state])
        conn.execute(f"INSERT INTO {fqn} BY NAME {select_sql}")
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def scoped(fqn: str, geo_extent: GeoExtent | None) -> str:
    """`fqn` narrowed to the import's states, for use in a FROM or JOIN; the
    whole table when there's no extent."""
    if geo_extent is None:
        return fqn
    return f"(SELECT * FROM {fqn} WHERE {geo_extent.states_sql()})"
