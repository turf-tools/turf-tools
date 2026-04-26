"""Hamilton graph for loading geographic boundary polygons into DuckLake.

A "boundary" here is a polygon that names an administrative unit — an NYC
Election District, a ZIP code area, a Census tract, etc. The same destination
table is populated regardless of source:

    geo_ducklake.boundaries.{key_group}
        key   VARCHAR    -- unique id within the key group (e.g. "65039")
        name  VARCHAR    -- nullable display label
        geom  GEOMETRY   -- polygon, simplified for map rendering

Two flavours of loader, same destination contract:

- ``boundary_from_geojson`` — for external sources (NYC Open Data, custom
  exports). Reads a GeoJSON file/URL via DuckDB's spatial ``ST_Read``.
- ``boundary_from_table`` — for sources already in DuckLake (TIGER ZCTAs,
  TIGER tracts, etc.). Pure SQL projection, no file fetch.

Both pre-simplify the geometry so the served file stays small. The
simplification tolerance is in degrees (EPSG:4326), so 0.0001 ≈ 11 m at the
equator — invisible at city zoom levels but cuts file size by ~5x.
"""

import duckdb

from src.models import TableRef

GEO_CATALOG = "geo_ducklake"
BOUNDARIES_SCHEMA = "boundaries"

# Default simplification tolerance in degrees. Matches "imperceptible at city
# zoom" while shrinking polygon vertex counts dramatically. Override per-call
# if you need finer or coarser geometry.
DEFAULT_SIMPLIFY_TOLERANCE = 0.0001


def _ensure_schema(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(f"CREATE SCHEMA IF NOT EXISTS {GEO_CATALOG}.{BOUNDARIES_SCHEMA}")


def _current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {GEO_CATALOG}.current_snapshot()").fetchone()[0]


def boundary_from_geojson(
    geojson_url: str,
    key_group: str,
    key_property: str,
    name_property: str | None,
    conn: duckdb.DuckDBPyConnection,
    simplify_tolerance: float = DEFAULT_SIMPLIFY_TOLERANCE,
) -> TableRef:
    """Load polygons from an external GeoJSON file/URL into ``boundaries.{key_group}``.

    Overwrites the destination table on each call — boundaries are static
    reference data, so a re-run replaces wholesale rather than diffing.

    Source rows missing the key property are silently dropped (rare, but
    real-world feeds occasionally have null props on geometry-only features).
    """
    _ensure_schema(conn)
    fqn = f"{GEO_CATALOG}.{BOUNDARIES_SCHEMA}.{key_group}"

    # ST_Read flattens GeoJSON properties to top-level columns, so we can
    # reference key_property / name_property directly. Cast to VARCHAR in
    # case the source has them as numbers.
    name_select = f"CAST({name_property} AS VARCHAR)" if name_property else "NULL"

    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        SELECT
            CAST({key_property} AS VARCHAR)                          AS key,
            {name_select}                                            AS name,
            ST_Simplify(geom, {simplify_tolerance})                  AS geom
        FROM ST_Read('{geojson_url}')
        WHERE {key_property} IS NOT NULL
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=GEO_CATALOG,
        schema=BOUNDARIES_SCHEMA,
        table=key_group,
        version=version,
    )


def boundary_from_table(
    source_table: TableRef,
    key_group: str,
    key_column: str,
    name_column: str | None,
    geom_column: str,
    conn: duckdb.DuckDBPyConnection,
    simplify_tolerance: float = DEFAULT_SIMPLIFY_TOLERANCE,
) -> TableRef:
    """Project an existing DuckLake polygon table into ``boundaries.{key_group}``.

    For TIGER-derived sources (ZCTAs, tracts) once the upstream raw table
    exists in ``geo_ducklake.tiger.*``. Cheaper than re-importing from a file.
    """
    _ensure_schema(conn)
    fqn = f"{GEO_CATALOG}.{BOUNDARIES_SCHEMA}.{key_group}"
    name_select = name_column if name_column else "NULL"

    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        SELECT
            {key_column}                                           AS key,
            {name_select}                                          AS name,
            ST_Simplify({geom_column}, {simplify_tolerance})       AS geom
        FROM {source_table.fqn}
        WHERE {key_column} IS NOT NULL
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=GEO_CATALOG,
        schema=BOUNDARIES_SCHEMA,
        table=key_group,
        version=version,
    )
