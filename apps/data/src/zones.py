"""Zone helpers: definition keys and boundary geometry."""

from __future__ import annotations

from typing import TYPE_CHECKING

from src.cache import singleflight_lru

if TYPE_CHECKING:
    import duckdb

# Boundary polygons are simplified per feature at seed time, so adjacent
# shapes disagree along shared edges by up to the simplification
# tolerance (0.0001°) — a plain union inherits that as slivers and
# hairline cracks, which the renderer's per-zoom re-simplification shows
# as flickering triangles and trapped inner lines. Closing the union
# (dilate+erode at that tolerance) seals them; the trailing simplify
# strips the buffer's corner-rounding micro-vertices.
PERIMETER_CLOSE_TOLERANCE = 0.0001
PERIMETER_SIMPLIFY_TOLERANCE = 0.00001


def flatten_zone_keys(zones: list[tuple[str, list[str]]]) -> tuple[list[str], list[str]]:
    """(zone_id, keys) pairs → parallel arrays for a zone-key unnest join."""
    zone_ids: list[str] = []
    keys: list[str] = []
    for zone_id, zone_keys in zones:
        zone_ids.extend([zone_id] * len(zone_keys))
        keys.extend(zone_keys)
    return zone_ids, keys


def zone_target_counts_sql(persons_fqn: str, key_expr: str, where: str) -> str:
    """Per-zone people and door counts for the conditioned population.
    Binds [zone_ids, keys, *where_params]."""
    return f"""
        WITH zk AS (SELECT unnest(?) AS zone_id, unnest(?) AS key)
        SELECT zk.zone_id, count(*), count(DISTINCT door_i)
        FROM {persons_fqn} JOIN zk ON {key_expr} = zk.key
        {where}
        GROUP BY zk.zone_id
    """


PERIMETER_CACHE_BYTES = 32 * 2**20


@singleflight_lru(
    PERIMETER_CACHE_BYTES,
    sizeof=lambda v: len(v) if v else 1,
    key=lambda conn, boundary_fqn, keys: (boundary_fqn, keys),
)
def zone_perimeter_geojson(conn: duckdb.DuckDBPyConnection, boundary_fqn: str, keys: tuple[str, ...]) -> str | None:
    """One zone's sealed perimeter as a GeoJSON string, memoized. The
    result is pure in (boundary table, key set) — the FQN's schema
    carries the dataset version — so entries never go stale. Callers
    pass keys sorted so equal sets share an entry."""
    row = conn.execute(perimeter_union_sql(boundary_fqn), [list(keys)]).fetchone()
    return row[0] if row is not None else None


def perimeter_union_sql(boundary_fqn: str) -> str:
    """One sealed perimeter over a zone's boundary keys, as GeoJSON.
    Binds [keys]."""
    return f"""
        SELECT ST_AsGeoJSON(
            ST_SimplifyPreserveTopology(
                ST_Buffer(
                    ST_Buffer(ST_Union_Agg(ST_MakeValid(geom)), {PERIMETER_CLOSE_TOLERANCE}),
                    -{PERIMETER_CLOSE_TOLERANCE}
                ),
                {PERIMETER_SIMPLIFY_TOLERANCE}
            )
        )
        FROM {boundary_fqn} WHERE key IN (SELECT unnest(?))
    """
