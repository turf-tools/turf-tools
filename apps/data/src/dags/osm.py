"""Hamilton graph for preparing OSM-derived geographic reference data.

Parallels `tiger.py` — both modules write reference tables into
`geo_ducklake` that the downstream geocoding pipeline reads. This
module owns everything OSM-specific (extraction, parsing, building
lookup keying). The actual lat/lon assignment using both TIGER
blockfaces and OSM buildings happens in `geocode.py`.

Pipeline:

    osm_pbf  ─►  osm_buildings_polygons    (osmium-derived area centroids)
              ─►  osm_addresses             (raw OSM addressed elements)
              ─►  osm_landuse_residential   (assembled landuse polygons)

    osm_addresses + osm_landuse_residential + address_tokens
        ─►  osm_building_lookup            (per-building keyed for join)

Output: `geo_ducklake.osm.building_lookup` — one row per OSM-known
building, keyed on `(zip_code, canonical_key, housenumber_norm)`, with
the centroid lat/lon, raw `street` (canonical for display), and an
`in_residential_complex` flag.

Canonical key shape on both voter and OSM sides: sorted distinctive
(non-generic) street-name tokens after equivalency expansion via
`address_tokens`, joined with '|'. Same key on both sides → strict
text match → no cross-street collisions.
"""

import json
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

import duckdb
from src.addressing import (
    GENERIC_STREET_TOKENS,
    street_rewrite_sql,
    tokenize_street_sql,
)
from src.models import TableRef

GEO_CATALOG = "geo_ducklake"
OSM_SCHEMA = "osm"

# Inline SQL list of generic tokens for use in canonical_key derivation
# (strip generic tokens, sort the rest, join with '|').
_GENERIC_SQL = "[" + ", ".join(f"'{t}'" for t in GENERIC_STREET_TOKENS) + "]"


def _fqn(table: str) -> str:
    return f"{GEO_CATALOG}.{OSM_SCHEMA}.{table}"


def _ensure_schema(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(f"CREATE SCHEMA IF NOT EXISTS {GEO_CATALOG}.{OSM_SCHEMA}")


def _current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {GEO_CATALOG}.current_snapshot()").fetchone()[0]


# ---------------------------------------------------------------------------
# Node 1 – download (or reuse) the OSM PBF
# ---------------------------------------------------------------------------


def osm_pbf(osm_url: str, osm_data_dir: str) -> Path:
    """Download the Geofabrik PBF into ``osm_data_dir`` if not present."""
    cache = Path(osm_data_dir)
    cache.mkdir(parents=True, exist_ok=True)
    filename = osm_url.rsplit("/", 1)[-1]
    pbf_path = cache / filename
    if pbf_path.exists():
        size_mb = pbf_path.stat().st_size / (1024 * 1024)
        print(f"OSM PBF: {filename} ({size_mb:.1f} MB, cached)")
        return pbf_path
    print(f"Downloading OSM PBF: {osm_url}")
    urllib.request.urlretrieve(osm_url, pbf_path)
    size_mb = pbf_path.stat().st_size / (1024 * 1024)
    print(f"  done ({size_mb:.1f} MB)")
    return pbf_path


# ---------------------------------------------------------------------------
# Node 2 – building polygons (via osmium-tool)
# ---------------------------------------------------------------------------


def _require_osmium() -> str:
    """Locate osmium-tool on PATH or fail with an install hint."""
    osmium = shutil.which("osmium")
    if osmium is None:
        raise RuntimeError(
            "osmium-tool not found on PATH. Install:\n"
            "  macOS:  brew install osmium-tool\n"
            "  Debian: apt install osmium-tool"
        )
    return osmium


def osm_buildings_polygons(
    osm_pbf: Path,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Building polygons with area-weighted centroids.

    osmium-tool assembles closed-way + multipolygon-relation building
    geometries from the PBF (in C++, streaming, off-disk) and emits a
    GeoJSONSeq. We then load it via `ST_Read` and compute
    `ST_Centroid` per polygon — area-weighted so it's robust to vertex
    density artifacts (the bias we saw with in-DB vertex-means).

    `ST_PointOnSurface` fallback when the centroid lands outside a
    concave polygon (L-buildings, courtyard apartment blocks).

    Two on-disk caches live next to the PBF:
      - `<stem>-buildings.osm.pbf`     (filtered PBF, building-tagged
                                        ways/relations + their refs)
      - `<stem>-buildings.geojsonseq`  (assembled polygon features)

    Idempotent. Delete the geojsonseq to force re-extraction.
    """
    table = "buildings_polygons"
    fqn = _fqn(table)

    _ensure_schema(conn)
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            osm_id        BIGINT,
            geom          GEOMETRY,
            centroid_lat  DOUBLE,
            centroid_lon  DOUBLE
        )
    """)

    existing = conn.execute(f"SELECT count(*) FROM {fqn}").fetchone()[0]
    if existing > 0:
        return TableRef(catalog=GEO_CATALOG, schema=OSM_SCHEMA, table=table, version=_current_version(conn))

    filtered_pbf = osm_pbf.with_name(f"{osm_pbf.stem}-buildings.osm.pbf")
    geojson_path = osm_pbf.with_name(f"{osm_pbf.stem}-buildings.geojsonseq")
    config_path = osm_pbf.with_name("osmium-export-buildings.json")

    osmium = _require_osmium()

    # osmium-export config (https://docs.osmcode.org/osmium/latest/osmium-export.html):
    #   - emit @id and @type as the only attributes
    #   - linear_tags=false: skip linestrings entirely
    #   - area_tags=true:    export every area in the filtered PBF
    #   - include_tags=[building]: keep only the `building` tag as a
    #     property column. Avoids GDAL's case-insensitive collision
    #     between `fixme` / `FIXME` etc. when loading the geojsonseq.
    # Always rewrite so config edits take effect on next run.
    config_path.write_text(json.dumps({
        "attributes": {"id": True, "type": True},
        "linear_tags": False,
        "area_tags": True,
        "include_tags": ["building"],
    }))

    if not filtered_pbf.exists():
        print(f"Filtering buildings from {osm_pbf.name}…")
        subprocess.run(
            [osmium, "tags-filter", str(osm_pbf), "wr/building", "-o", str(filtered_pbf)],
            check=True,
        )
        size_mb = filtered_pbf.stat().st_size / (1024 * 1024)
        print(f"  done ({size_mb:.1f} MB)")

    if not geojson_path.exists():
        print("Exporting building polygons to GeoJSONSeq…")
        subprocess.run(
            [osmium, "export", str(filtered_pbf),
             "-c", str(config_path),
             "-f", "geojsonseq",
             "-o", str(geojson_path)],
            check=True,
        )
        size_mb = geojson_path.stat().st_size / (1024 * 1024)
        print(f"  done ({size_mb:.1f} MB)")
    else:
        size_mb = geojson_path.stat().st_size / (1024 * 1024)
        print(f"Building GeoJSONSeq: {geojson_path.name} ({size_mb:.1f} MB, cached)")

    print(f"Loading polygons + computing centroids → {fqn}…")
    conn.execute(f"""
        INSERT INTO {fqn}
        WITH polys AS (
            SELECT TRY_CAST("@id" AS BIGINT) AS osm_id, geom
            FROM ST_Read('{geojson_path}')
            WHERE geom IS NOT NULL
        )
        SELECT
            osm_id,
            geom,
            CASE WHEN ST_Contains(geom, ST_Centroid(geom))
                 THEN ST_Y(ST_Centroid(geom))
                 ELSE ST_Y(ST_PointOnSurface(geom))
            END AS centroid_lat,
            CASE WHEN ST_Contains(geom, ST_Centroid(geom))
                 THEN ST_X(ST_Centroid(geom))
                 ELSE ST_X(ST_PointOnSurface(geom))
            END AS centroid_lon
        FROM polys
        WHERE osm_id IS NOT NULL
    """)
    n = conn.execute(f"SELECT count(*) FROM {fqn}").fetchone()[0]
    print(f"  {n:,} building polygons loaded")

    return TableRef(catalog=GEO_CATALOG, schema=OSM_SCHEMA, table=table, version=_current_version(conn))


# ---------------------------------------------------------------------------
# Node 3 – addressed OSM elements, raw positions only
# ---------------------------------------------------------------------------


def osm_addresses(
    osm_pbf: Path,
    osm_buildings_polygons: TableRef,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """One row per address-tagged OSM element with its raw lat/lon.

    Nodes use their own (door) lat/lon. Ways are looked up in
    `osm_buildings_polygons` to use the area-weighted ST_Centroid
    of the assembled polygon (osmium-tool extraction). Way-tagged
    addresses whose polygon couldn't be assembled (multipolygon
    relations not yet supported, or otherwise) are dropped.

    Idempotent: returns the existing TableRef when the table is populated.
    """
    table = "addresses"
    fqn = _fqn(table)

    _ensure_schema(conn)
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            osm_id        BIGINT,
            kind          VARCHAR,
            housenumber   VARCHAR,
            street        VARCHAR,
            unit          VARCHAR,
            zip_code      VARCHAR,
            city          VARCHAR,
            state         VARCHAR,
            building      VARCHAR,
            lat           DOUBLE,
            lon           DOUBLE
        )
    """)

    existing = conn.execute(f"SELECT count(*) FROM {fqn}").fetchone()[0]
    if existing > 0:
        return TableRef(catalog=GEO_CATALOG, schema=OSM_SCHEMA, table=table, version=_current_version(conn))

    polys_fqn = osm_buildings_polygons.fqn

    print("Loading addressed OSM elements…")
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _addressed AS
        SELECT
            id, kind, lat, lon,
            list_extract(map_extract(tags, 'addr:housenumber'), 1) AS housenumber,
            list_extract(map_extract(tags, 'addr:street'),       1) AS street,
            list_extract(map_extract(tags, 'addr:unit'),         1) AS unit,
            list_extract(map_extract(tags, 'addr:postcode'),     1) AS zip_code,
            list_extract(map_extract(tags, 'addr:city'),         1) AS city,
            list_extract(map_extract(tags, 'addr:state'),        1) AS state,
            list_extract(map_extract(tags, 'building'),          1) AS building
        FROM ST_ReadOSM('{osm_pbf}')
        WHERE kind IN ('node', 'way')
          AND list_extract(map_extract(tags, 'addr:housenumber'), 1) IS NOT NULL
          AND list_extract(map_extract(tags, 'addr:street'),       1) IS NOT NULL
    """)

    print(f"  writing to {fqn}…")
    conn.execute(f"""
        INSERT INTO {fqn}
        SELECT
            a.id   AS osm_id,
            a.kind,
            a.housenumber,
            a.street,
            a.unit,
            a.zip_code,
            a.city,
            a.state,
            a.building,
            CASE WHEN a.kind = 'way' THEN p.centroid_lat ELSE a.lat END AS lat,
            CASE WHEN a.kind = 'way' THEN p.centroid_lon ELSE a.lon END AS lon
        FROM _addressed a
        LEFT JOIN {polys_fqn} p ON p.osm_id = a.id
        WHERE (a.kind = 'way'  AND p.centroid_lat IS NOT NULL)
           OR (a.kind = 'node' AND a.lat IS NOT NULL)
    """)

    total = conn.execute(f"SELECT count(*) FROM {fqn}").fetchone()[0]
    by_kind = conn.execute(f"""
        SELECT kind, count(*) AS n FROM {fqn} GROUP BY 1 ORDER BY n DESC
    """).fetchall()
    print(f"  loaded {total:,} OSM addresses:")
    for kind, n in by_kind:
        print(f"    {kind:>4}: {n:,}")

    return TableRef(catalog=GEO_CATALOG, schema=OSM_SCHEMA, table=table, version=_current_version(conn))


# ---------------------------------------------------------------------------
# Node 3 – landuse=residential polygons (for the future complex-override step)
# ---------------------------------------------------------------------------


def osm_landuse_residential(
    osm_pbf: Path,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Assembled `landuse=residential` polygons. Way-only — multipolygon
    relations are rare (~14 of ~13k state-wide) and skipped in v1.

    Used downstream as the test for "is this voter inside a residential
    complex" — the complex-centroid override step that bypasses the
    blockface projection. Not yet wired through `refined_positions`.

    Idempotent: returns the existing TableRef when the table is populated.
    """
    table = "landuse_residential"
    fqn = _fqn(table)

    _ensure_schema(conn)
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            landuse_id  BIGINT,
            name        VARCHAR,
            geom        GEOMETRY
        )
    """)

    existing = conn.execute(f"SELECT count(*) FROM {fqn}").fetchone()[0]
    if existing > 0:
        return TableRef(catalog=GEO_CATALOG, schema=OSM_SCHEMA, table=table, version=_current_version(conn))

    print("Loading landuse=residential ways…")
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _landuse_res AS
        SELECT id, refs,
               list_extract(map_extract(tags, 'name'), 1) AS name
        FROM ST_ReadOSM('{osm_pbf}') o
        WHERE kind = 'way'
          AND list_extract(map_extract(tags, 'landuse'), 1) = 'residential'
    """)

    print("  reading node positions for landuse refs…")
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE _needed_node_ids AS
        SELECT DISTINCT u.ref_id AS id FROM _landuse_res, UNNEST(refs) AS u(ref_id)
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _landuse_node_pos AS
        SELECT o.id, o.lat, o.lon
        FROM ST_ReadOSM('{osm_pbf}') o
        JOIN _needed_node_ids n ON n.id = o.id
        WHERE o.kind = 'node'
    """)

    print("  assembling polygons (close-aware)…")
    conn.execute(f"""
        INSERT INTO {fqn}
        WITH ordered_pts AS (
            SELECT lr.id AS landuse_id, lr.name, u.idx, np.lat, np.lon
            FROM _landuse_res lr,
                 UNNEST(lr.refs) WITH ORDINALITY AS u(ref_id, idx)
            JOIN _landuse_node_pos np ON np.id = u.ref_id
        ),
        agg AS (
            SELECT landuse_id, name,
                   CASE WHEN list_extract(list(lat ORDER BY idx), 1)
                          = list_extract(list(lat ORDER BY idx DESC), 1)
                        AND list_extract(list(lon ORDER BY idx), 1)
                          = list_extract(list(lon ORDER BY idx DESC), 1)
                        THEN list(ST_Point(lon, lat) ORDER BY idx)
                        ELSE list_concat(
                            list(ST_Point(lon, lat) ORDER BY idx),
                            [list_extract(list(ST_Point(lon, lat) ORDER BY idx), 1)]
                        )
                   END AS closed_pts
            FROM ordered_pts GROUP BY 1, 2
        )
        SELECT landuse_id, name,
               TRY_CAST(ST_MakePolygon(ST_MakeLine(closed_pts)) AS GEOMETRY) AS geom
        FROM agg
        WHERE len(closed_pts) >= 4
    """)

    total = conn.execute(f"SELECT count(*) FROM {fqn}").fetchone()[0]
    named = conn.execute(f"SELECT count(*) FROM {fqn} WHERE name IS NOT NULL").fetchone()[0]
    print(f"  loaded {total:,} landuse=residential polygons ({named:,} named)")

    return TableRef(catalog=GEO_CATALOG, schema=OSM_SCHEMA, table=table, version=_current_version(conn))


# ---------------------------------------------------------------------------
# Per-building OSM lookup keyed by (zip, canonical_key, housenumber_norm).
# Built once per run from osm_addresses + osm_landuse_residential, consumed
# by refined_positions and osm_only_matches.
# ---------------------------------------------------------------------------


def osm_building_lookup(
    osm_addresses: TableRef,
    osm_landuse_residential: TableRef,
    address_tokens: TableRef,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """One row per OSM-known building, keyed for fast voter lookup.

    Schema: (zip_code, canonical_key, housenumber, housenumber_norm,
              street, osm_lat, osm_lon, in_residential_complex)

    Derives canonical_key by tokenizing the OSM `street` (with
    STREET_REWRITES applied), equivalency-expanding via
    `address_tokens`, stripping generics, sorting, and joining with '|'.
    housenumber_norm strips leading zeros after hyphens then strips
    hyphens entirely (matches the voter-side normalization).
    in_residential_complex is true when the building centroid falls
    inside a landuse=residential polygon.

    Non-incremental: drops + recreates each run so changes to
    STREET_REWRITES or address_tokens take effect immediately.
    """
    table = "building_lookup"
    fqn = _fqn(table)
    _ensure_schema(conn)
    conn.execute(f"DROP TABLE IF EXISTS {fqn}")

    print(f"Building {fqn}…")
    t0 = time.time()

    osm = osm_addresses.fqn
    tok = address_tokens.fqn
    res = osm_landuse_residential.fqn

    # STREET_REWRITES (see src/addressing.py) normalize OSM's surface
    # form toward TIGER's before tokenizing.
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _bl_raw_tokens AS
        SELECT
            osm_id, kind, housenumber, zip_code, lat, lon, street,
            {tokenize_street_sql(street_rewrite_sql("street"))} AS raw_tokens
        FROM {osm}
        WHERE zip_code IS NOT NULL
          AND street   IS NOT NULL
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _bl_keyed AS
        WITH extras AS (
            SELECT b.osm_id, flatten(list(t.equivalent_tokens)) AS extra
            FROM _bl_raw_tokens b
            JOIN {tok} t ON len(list_intersect(b.raw_tokens, t.equivalent_tokens)) > 0
            GROUP BY b.osm_id
        ),
        combined AS (
            SELECT
                b.osm_id, b.kind, b.housenumber, b.zip_code, b.lat, b.lon, b.street,
                list_distinct(list_concat(b.raw_tokens, COALESCE(e.extra, []))) AS expanded
            FROM _bl_raw_tokens b LEFT JOIN extras e USING (osm_id)
        )
        SELECT osm_id, kind, housenumber, zip_code, lat, lon, street,
               array_to_string(
                   list_sort(list_filter(expanded,
                       t -> NOT list_contains({_GENERIC_SQL}, t))),
                   '|'
               ) AS canonical_key
        FROM combined
        WHERE expanded IS NOT NULL
    """)

    # If both a way and a node exist for the same building, prefer the
    # way (polygon centroid > doorway point). Flag buildings whose
    # centroid is inside a landuse=residential polygon — those voters
    # get the OSM centroid directly without road projection.
    # housenumber_norm: strip leading zeros after hyphens (Queens
    # "132-01" → "132-1") then strip hyphens (Manhattan "11-15" → "1115").
    # Group by housenumber_norm (not raw housenumber) so OSM variants
    # like "90-02" and "90-2" — same building, different tagging —
    # merge into one row.
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        WITH keyed_norm AS (
            SELECT zip_code, canonical_key, housenumber, street, lat, lon, kind,
                   regexp_replace(
                       regexp_replace(housenumber, '(^|-)0*([0-9])', '\\1\\2', 'g'),
                       '-', '', 'g'
                   ) AS housenumber_norm
            FROM _bl_keyed
            WHERE canonical_key != ''
        ),
        agg AS (
            SELECT zip_code, canonical_key, housenumber_norm,
                   arg_max(housenumber, kind = 'way') AS housenumber,
                   arg_max(lat,         kind = 'way') AS osm_lat,
                   arg_max(lon,         kind = 'way') AS osm_lon,
                   arg_max(street,      kind = 'way') AS street
            FROM keyed_norm
            GROUP BY 1, 2, 3
        )
        SELECT zip_code, canonical_key, housenumber, housenumber_norm,
               street, osm_lat, osm_lon,
               EXISTS (
                   SELECT 1 FROM {res} r
                   WHERE ST_Contains(r.geom, ST_Point(osm_lon, osm_lat))
               ) AS in_residential_complex
        FROM agg
    """)
    n = conn.execute(f"SELECT count(*) FROM {fqn}").fetchone()[0]
    print(f"  {n:,} buildings keyed in {time.time()-t0:.1f}s")

    return TableRef(catalog=GEO_CATALOG, schema=OSM_SCHEMA, table=table,
                    version=_current_version(conn))

