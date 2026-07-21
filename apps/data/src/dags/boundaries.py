"""Load administrative boundary polygons into DuckLake.

A "boundary" is a polygon naming an administrative unit (Election
Districts, ZIP areas, Census tracts, …). All loaders write to the
same destination shape:

    ducklake.{schema}.{key_group}
        key   VARCHAR    -- unique id within the key group
        name  VARCHAR    -- nullable display label
        geom  GEOMETRY   -- polygon, pre-simplified for map rendering

Boundaries live in the org catalog (alongside `persons_geocoded`,
`buildings_geocoded`, etc.) rather than the geo catalog, because they're
derived from each org's voter scope — two orgs running `seed-boundaries`
with different fixtures produce different `nyc_eds` tables. The shared
TIGER reference data stays under `ducklake_geo.tiger.*`, and OSM under
`ducklake_geo.osm.*`.

Three loaders share that contract:

- `boundary_from_blocks` (preferred) — derive polygons from the voter
  file by unioning the TIGER census blocks that voters with each key
  live in. No external shapefile needed; polygons match the voter
  file by construction.
- `boundary_from_geojson` — read an external GeoJSON file/URL via
  `ST_Read`. Escape hatch for key groups without voter coverage.
- `boundary_from_table` — project from a table already in DuckLake
  (TIGER ZCTAs, tracts, …). Pure SQL, no file fetch.

Geometry is pre-simplified at `DEFAULT_SIMPLIFY_TOLERANCE` (0.0001° ≈
11 m at the equator — invisible at city zoom but ~5× smaller file).
"""

import duckdb
from src.models import TableRef
from src.tables import PERSON_CATALOG, ensure_schema, table_fqn

# Default simplification tolerance in degrees. Matches "imperceptible at city
# zoom" while shrinking polygon vertex counts dramatically. Override per-call
# if you need finer or coarser geometry.
DEFAULT_SIMPLIFY_TOLERANCE = 0.0001


def _current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {PERSON_CATALOG}.current_snapshot()").fetchone()[0]


def boundary_from_geojson(
    geojson_url: str,
    key_group: str,
    key_property: str,
    name_property: str | None,
    schema: str,
    conn: duckdb.DuckDBPyConnection,
    simplify_tolerance: float = DEFAULT_SIMPLIFY_TOLERANCE,
) -> TableRef:
    """Load polygons from an external GeoJSON file/URL into ``{schema}.{key_group}``.

    Overwrites the destination table on each call — re-running replaces
    wholesale rather than diffing.

    Source rows missing the key property are silently dropped (rare, but
    real-world feeds occasionally have null props on geometry-only features).
    """
    ensure_schema(conn, schema)
    fqn = table_fqn(schema, key_group)

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
        catalog=PERSON_CATALOG,
        schema=schema,
        table=key_group,
        version=version,
    )


def boundary_from_blocks(
    persons_geocoded: TableRef,
    tiger_tabblock_raw: TableRef,
    key_group: str,
    key_expression: str,
    schema: str,
    conn: duckdb.DuckDBPyConnection,
    simplify_tolerance: float = DEFAULT_SIMPLIFY_TOLERANCE,
) -> TableRef:
    """Derive per-key polygons from the voter file + TIGER census blocks.

    For each distinct key value, takes the set of blocks where any voter
    tagged with that key lives, unions them into a single polygon, and
    writes one row to ``{schema}.{key_group}``. No external
    boundary shapefile is involved; the polygon for ED 23-001 literally is
    the union of blocks containing voters with `precinct = '23-001'`. The
    polygon for ZIP 11211 is the union of blocks containing voters with
    `zip5 = '11211'` — which sidesteps the ZIP5/MODZCTA-shape mismatch
    that plagues external ZIP shapefiles.

    `key_expression` is a SQL fragment producing the key from a row in
    the geocoded persons table, e.g.:
      - ``"zip5"``                                                for ZIPs
      - ``"precinct"``                                            for AD-EDs

    Each block is assigned to *one* key — the key with the most voters
    in that block — so polygons partition cleanly instead of
    overlapping. Without majority assignment a block straddling two EDs
    (most blocks, since ED lines don't follow block edges) would land
    in both polygons. Ties broken by key ASC for stability.

    Spatial join uses distinct (key, lng, lat) tuples with voter
    counts collapsed in. Voters within a building share coordinates,
    so this drops ~5M voters down to ~600K building-key tuples on the
    NYC sample, ~10x speedup vs. joining one row per voter.

    Land blocks that contain no voters (parks, industrial parcels,
    cemetery blocks, etc.) are backfilled by nearest-neighbor: each
    unassigned land block inherits the key of the closest voter-
    assigned block by centroid distance. Without this, large
    no-voter blocks become visible holes in the polygon coverage,
    especially for ZIPs.

    Water-only blocks (``land_area = 0``) are excluded from
    backfilling so polygons don't extend across rivers, the harbor,
    Central Park's reservoir, etc.
    """
    ensure_schema(conn, schema)
    fqn = table_fqn(schema, key_group)
    persons_fqn = persons_geocoded.fqn
    tabblock_fqn = tiger_tabblock_raw.fqn

    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        WITH unique_points AS (
            SELECT
                ({key_expression}) AS key,
                longitude,
                latitude,
                COUNT(*) AS voters_at_point
            FROM {persons_fqn}
            WHERE ({key_expression}) IS NOT NULL
            GROUP BY 1, 2, 3
        ),
        point_blocks AS (
            SELECT
                up.key,
                up.voters_at_point,
                b.block_geoid,
                b.geom AS block_geom
            FROM unique_points up
            JOIN {tabblock_fqn} b
              ON ST_Contains(b.geom, ST_Point(up.longitude, up.latitude))
        ),
        block_key_counts AS (
            SELECT
                block_geoid,
                key,
                SUM(voters_at_point) AS voter_count,
                ANY_VALUE(block_geom) AS block_geom
            FROM point_blocks
            GROUP BY block_geoid, key
        ),
        winning_key AS (
            SELECT block_geoid, key, block_geom
            FROM (
                SELECT
                    *,
                    ROW_NUMBER() OVER (
                        PARTITION BY block_geoid
                        ORDER BY voter_count DESC, key
                    ) AS rn
                FROM block_key_counts
            )
            WHERE rn = 1
        ),
        -- Pre-compute centroids once: nearest-neighbor uses
        -- centroid-to-centroid distance (cheap, ~point-vs-point)
        -- rather than full polygon-to-polygon ST_Distance, which
        -- would be ~30x slower for the same conceptual answer at
        -- block scale.
        winning_centroids AS (
            SELECT block_geoid, key, ST_Centroid(block_geom) AS centroid
            FROM winning_key
        ),
        unassigned AS (
            SELECT b.block_geoid, b.geom AS block_geom, ST_Centroid(b.geom) AS centroid
            FROM {tabblock_fqn} b
            LEFT JOIN winning_key wk USING (block_geoid)
            WHERE wk.block_geoid IS NULL
              AND b.land_area > 0
        ),
        backfilled AS (
            SELECT
                u.block_geoid,
                (
                    SELECT wk.key
                    FROM winning_centroids wk
                    ORDER BY ST_Distance(wk.centroid, u.centroid)
                    LIMIT 1
                )                                              AS key,
                u.block_geom
            FROM unassigned u
        ),
        all_assignments AS (
            SELECT block_geoid, key, block_geom FROM winning_key
            UNION ALL
            SELECT block_geoid, key, block_geom FROM backfilled
        )
        SELECT
            key,
            NULL                                                          AS name,
            ST_Simplify(ST_Union_Agg(block_geom), {simplify_tolerance})   AS geom
        FROM all_assignments
        GROUP BY key
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=schema,
        table=key_group,
        version=version,
    )


def boundary_from_table(
    source_table: TableRef,
    key_group: str,
    key_column: str,
    name_column: str | None,
    geom_column: str,
    schema: str,
    conn: duckdb.DuckDBPyConnection,
    simplify_tolerance: float = DEFAULT_SIMPLIFY_TOLERANCE,
) -> TableRef:
    """Project an existing DuckLake polygon table into ``{schema}.{key_group}``.

    For TIGER-derived sources (ZCTAs, tracts) once the upstream raw table
    exists in ``ducklake_geo.tiger.*``. Cheaper than re-importing from a file.
    """
    ensure_schema(conn, schema)
    fqn = table_fqn(schema, key_group)
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
        catalog=PERSON_CATALOG,
        schema=schema,
        table=key_group,
        version=version,
    )
