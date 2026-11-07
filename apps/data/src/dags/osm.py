"""Prepare OSM reference data for address matching.

Parallels `tiger.py`: extracts OSM-derived data into `ducklake_geo`
for the geocoding pipeline. The actual lat/lon assignment (using
both TIGER blockfaces and OSM buildings) lives in `geocode.py`.

OSM comes in Geofabrik's per-state extracts. Each state the import's
addresses fall in (`geo_extent`) is built once, tagged `state_fips`, and
serves every later import that touches it.

    osm_states_built ─► osm_pbfs ─┬─► osm_buildings_polygons   (building polygon centroids)
                                  ├─► osm_addresses            (addressed OSM elements)
                                  └─► osm_landuse_residential  (residential land-use polygons)

    osm_addresses + osm_landuse_residential + address_tokens
        ─► osm_building_lookup               (per-building, keyed for join)

`osm_building_lookup` is the consumer-facing output — one row per
OSM-known building, keyed on `(zip_code, canonical_key, housenumber_norm)`.
"""

import json
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import duckdb
from src.addressing import (
    canonical_key_sql,
    housenumber_norm_sql,
    street_rewrite_sql,
    tokenize_street_sql,
)
from src.models import GeoExtent, TableRef

GEO_CATALOG = "ducklake_geo"
OSM_SCHEMA = "osm"

GEOFABRIK_US_URL = "https://download.geofabrik.de/north-america/us"
# State FIPS → Geofabrik extract name: the 50 states, DC, and Puerto Rico.
GEOFABRIK_REGIONS: dict[str, str] = {
    "01": "alabama",
    "02": "alaska",
    "04": "arizona",
    "05": "arkansas",
    "06": "california",
    "08": "colorado",
    "09": "connecticut",
    "10": "delaware",
    "11": "district-of-columbia",
    "12": "florida",
    "13": "georgia",
    "15": "hawaii",
    "16": "idaho",
    "17": "illinois",
    "18": "indiana",
    "19": "iowa",
    "20": "kansas",
    "21": "kentucky",
    "22": "louisiana",
    "23": "maine",
    "24": "maryland",
    "25": "massachusetts",
    "26": "michigan",
    "27": "minnesota",
    "28": "mississippi",
    "29": "missouri",
    "30": "montana",
    "31": "nebraska",
    "32": "nevada",
    "33": "new-hampshire",
    "34": "new-jersey",
    "35": "new-mexico",
    "36": "new-york",
    "37": "north-carolina",
    "38": "north-dakota",
    "39": "ohio",
    "40": "oklahoma",
    "41": "oregon",
    "42": "pennsylvania",
    "44": "rhode-island",
    "45": "south-carolina",
    "46": "south-dakota",
    "47": "tennessee",
    "48": "texas",
    "49": "utah",
    "50": "vermont",
    "51": "virginia",
    "53": "washington",
    "54": "west-virginia",
    "55": "wisconsin",
    "56": "wyoming",
    "72": "puerto-rico",
}


def _fqn(table: str) -> str:
    return f"{GEO_CATALOG}.{OSM_SCHEMA}.{table}"


def _ensure_schema(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(f"CREATE SCHEMA IF NOT EXISTS {GEO_CATALOG}.{OSM_SCHEMA}")


def _current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {GEO_CATALOG}.current_snapshot()").fetchone()[0]


# ---------------------------------------------------------------------------
# Node 1 – download (or reuse) each needed state's PBF
# ---------------------------------------------------------------------------


# The tables built from the PBFs, one state at a time.
_PBF_TABLES = ("buildings_polygons", "addresses", "landuse_residential")


def _ensure_state_table(conn: duckdb.DuckDBPyConnection, table: str, columns: str) -> str:
    """Create `table` with `columns` plus `state_fips` if missing, and return its fqn."""
    fqn = _fqn(table)
    _ensure_schema(conn)
    conn.execute(f"CREATE TABLE IF NOT EXISTS {fqn} ({columns}, state_fips VARCHAR)")
    return fqn


def osm_states_built(conn: duckdb.DuckDBPyConnection) -> dict[str, set[str]]:
    """The states each PBF-derived table already holds, read once per import
    and shared by every node below."""
    built: dict[str, set[str]] = {}
    for table in _PBF_TABLES:
        try:
            rows = conn.execute(f"SELECT DISTINCT state_fips FROM {_fqn(table)}").fetchall()
        except duckdb.CatalogException:
            rows = []  # table doesn't exist yet — fresh install
        built[table] = {r[0] for r in rows}
    return built


def osm_pbfs(
    geo_extent: GeoExtent,
    osm_states_built: dict[str, set[str]],
    osm_snapshot: str,
    osm_data_dir: str,
) -> dict[str, Path]:
    """The Geofabrik PBF of each extent state whose OSM tables aren't all built
    yet, keyed by state FIPS, downloaded into ``osm_data_dir`` if not present.
    States already built in every table need no PBF and are left out."""
    built = set.intersection(*osm_states_built.values())
    cache = Path(osm_data_dir)
    cache.mkdir(parents=True, exist_ok=True)
    pbfs: dict[str, Path] = {}
    for state in geo_extent.states:
        if state in built:
            continue
        region = GEOFABRIK_REGIONS.get(state)
        if region is None:
            raise ValueError(f"No OpenStreetMap extract is available for state FIPS {state}.")
        filename = f"{region}-{osm_snapshot}.osm.pbf"
        pbf_path = cache / filename
        pbfs[state] = pbf_path
        if pbf_path.exists():
            size_mb = pbf_path.stat().st_size / (1024 * 1024)
            print(f"OSM PBF: {filename} ({size_mb:.1f} MB, cached)")
            continue
        url = f"{GEOFABRIK_US_URL}/{filename}"
        print(f"Downloading OSM PBF: {url}")
        # Download beside the target and rename, so an interrupted download
        # never looks cached.
        partial = pbf_path.with_name(f"{filename}.part")
        try:
            urllib.request.urlretrieve(url, partial)
            partial.rename(pbf_path)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise RuntimeError(
                    f"OSM snapshot {filename} is no longer on Geofabrik; set osm_snapshot to a newer YY0101 date."
                ) from exc
            raise
        size_mb = pbf_path.stat().st_size / (1024 * 1024)
        print(f"  done ({size_mb:.1f} MB)")
    return pbfs


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
    osm_pbfs: dict[str, Path],
    osm_states_built: dict[str, set[str]],
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

    Two on-disk caches live next to each PBF:
      - `<stem>-buildings.osm.pbf`     (filtered PBF, building-tagged
                                        ways/relations + their refs)
      - `<stem>-buildings.geojsonseq`  (assembled polygon features)

    Incremental per state: skips states already loaded. Delete a
    geojsonseq to force its re-extraction.
    """
    table = "buildings_polygons"
    fqn = _ensure_state_table(
        conn,
        table,
        "osm_id BIGINT, centroid_lat DOUBLE, centroid_lon DOUBLE",
    )
    built = osm_states_built[table]

    for state, osm_pbf in osm_pbfs.items():
        if state in built:
            continue
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
        config_path.write_text(
            json.dumps(
                {
                    "attributes": {"id": True, "type": True},
                    "linear_tags": False,
                    "area_tags": True,
                    "include_tags": ["building"],
                }
            )
        )

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
                [
                    osmium,
                    "export",
                    str(filtered_pbf),
                    "-c",
                    str(config_path),
                    "-f",
                    "geojsonseq",
                    "-o",
                    str(geojson_path),
                ],
                check=True,
            )
            size_mb = geojson_path.stat().st_size / (1024 * 1024)
            print(f"  done ({size_mb:.1f} MB)")
        else:
            size_mb = geojson_path.stat().st_size / (1024 * 1024)
            print(f"Building GeoJSONSeq: {geojson_path.name} ({size_mb:.1f} MB, cached)")

        print("Loading building polygons + computing centroids…")
        conn.execute(f"""
            INSERT INTO {fqn}
            WITH polys AS (
                SELECT TRY_CAST("@id" AS BIGINT) AS osm_id, geom
                FROM ST_Read('{geojson_path}')
                WHERE geom IS NOT NULL
            ),
            centroided AS (
                SELECT osm_id, geom, ST_Centroid(geom) AS c FROM polys
            ),
            anchored AS (
                SELECT osm_id,
                    CASE WHEN ST_Contains(geom, c) THEN c
                         ELSE ST_PointOnSurface(geom) END AS pt
                FROM centroided
            )
            SELECT osm_id, ST_Y(pt) AS centroid_lat, ST_X(pt) AS centroid_lon, '{state}' AS state_fips
            FROM anchored
            WHERE osm_id IS NOT NULL
        """)
        n = conn.execute(f"SELECT count(*) FROM {fqn} WHERE state_fips = ?", [state]).fetchone()[0]
        print(f"  {n:,} building polygons loaded")

    return TableRef(catalog=GEO_CATALOG, schema=OSM_SCHEMA, table=table, version=_current_version(conn))


# ---------------------------------------------------------------------------
# Node 3 – addressed OSM elements, raw positions only
# ---------------------------------------------------------------------------


def osm_addresses(
    osm_pbfs: dict[str, Path],
    osm_states_built: dict[str, set[str]],
    osm_buildings_polygons: TableRef,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """One row per address-tagged OSM element with its raw lat/lon.

    Nodes use their own (door) lat/lon. Ways are looked up in
    `osm_buildings_polygons` to use the area-weighted ST_Centroid
    of the assembled polygon (osmium-tool extraction). Way-tagged
    addresses whose polygon couldn't be assembled (multipolygon
    relations not yet supported, or otherwise) are dropped.

    Incremental per state: skips states already loaded. An element in
    more than one state's extract gets a row per state;
    `osm_building_lookup` keeps one per address.
    """
    table = "addresses"
    fqn = _ensure_state_table(
        conn,
        table,
        """
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
        """,
    )
    built = osm_states_built[table]
    polys_fqn = osm_buildings_polygons.fqn

    for state, osm_pbf in osm_pbfs.items():
        if state in built:
            continue
        print(f"Loading addressed OSM elements from {osm_pbf.name}…")
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
                CASE WHEN a.kind = 'way' THEN p.centroid_lon ELSE a.lon END AS lon,
                '{state}' AS state_fips
            FROM _addressed a
            LEFT JOIN {polys_fqn} p ON p.osm_id = a.id AND p.state_fips = '{state}'
            WHERE (a.kind = 'way'  AND p.centroid_lat IS NOT NULL)
               OR (a.kind = 'node' AND a.lat IS NOT NULL)
        """)

        by_kind = conn.execute(
            f"SELECT kind, count(*) AS n FROM {fqn} WHERE state_fips = ? GROUP BY 1 ORDER BY n DESC",
            [state],
        ).fetchall()
        print(f"  loaded {sum(n for _, n in by_kind):,} OSM addresses:")
        for kind, n in by_kind:
            print(f"    {kind:>4}: {n:,}")

    return TableRef(catalog=GEO_CATALOG, schema=OSM_SCHEMA, table=table, version=_current_version(conn))


# ---------------------------------------------------------------------------
# Node 3 – landuse=residential polygons (for the future complex-override step)
# ---------------------------------------------------------------------------


def osm_landuse_residential(
    osm_pbfs: dict[str, Path],
    osm_states_built: dict[str, set[str]],
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Assembled `landuse=residential` polygons. Way-only — multipolygon
    relations are rare (~14 of ~13k state-wide) and skipped in v1.

    Used downstream as the test for "is this voter inside a residential
    complex" — the complex-centroid override step that bypasses the
    blockface projection.

    Incremental per state: skips states already loaded.
    """
    table = "landuse_residential"
    fqn = _ensure_state_table(conn, table, "landuse_id BIGINT, name VARCHAR, geom GEOMETRY")
    built = osm_states_built[table]

    for state, osm_pbf in osm_pbfs.items():
        if state in built:
            continue
        print(f"Loading landuse=residential ways from {osm_pbf.name}…")
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
                   TRY_CAST(ST_MakePolygon(ST_MakeLine(closed_pts)) AS GEOMETRY) AS geom,
                   '{state}' AS state_fips
            FROM agg
            WHERE len(closed_pts) >= 4
        """)

        total, named = conn.execute(f"SELECT count(*), count(name) FROM {fqn} WHERE state_fips = ?", [state]).fetchone()
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

    print("Building OSM building lookup…")
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
    # Inverted-index equivalency expansion: explode raw_tokens to
    # (osm_id, token) and address_tokens groups to (group_array, token),
    # equi-join on token, dedupe by (osm_id, group_array), then flatten
    # the matched group arrays into `extra`. Replaces a cross-product
    # filtered by `len(list_intersect(...)) > 0` that doesn't scale.
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _bl_keyed AS
        WITH b_tok AS (
            SELECT osm_id, t
            FROM _bl_raw_tokens, UNNEST(raw_tokens) AS u(t)
        ),
        g_tok AS (
            SELECT equivalent_tokens, t
            FROM {tok}, UNNEST(equivalent_tokens) AS u(t)
        ),
        matched AS (
            SELECT DISTINCT b.osm_id, g.equivalent_tokens
            FROM b_tok b JOIN g_tok g ON g.t = b.t
        ),
        extras AS (
            SELECT osm_id, flatten(list(equivalent_tokens)) AS extra
            FROM matched
            GROUP BY osm_id
        ),
        combined AS (
            SELECT
                b.osm_id, b.kind, b.housenumber, b.zip_code, b.lat, b.lon, b.street,
                list_distinct(list_concat(b.raw_tokens, COALESCE(e.extra, []))) AS expanded
            FROM _bl_raw_tokens b LEFT JOIN extras e USING (osm_id)
        )
        SELECT osm_id, kind, housenumber, zip_code, lat, lon, street,
               {canonical_key_sql("expanded")} AS canonical_key
        FROM combined
        WHERE expanded IS NOT NULL
    """)

    # Group by housenumber_norm (not the raw `housenumber` string) so
    # OSM tagging variants for the same physical building — `90-2` /
    # `90-02`, `1115` / `11-15` — merge into one row.
    #
    # Pick the OSM record per group via ROW_NUMBER: prefer way (polygon
    # centroid) over node (doorway point); break ties on osm_id ASC for
    # deterministic output.
    #
    # in_residential_complex is computed as a one-shot spatial
    # semi-join rather than per-row correlated EXISTS so DuckDB's
    # spatial bbox pre-filter applies.
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        WITH keyed_norm AS (
            SELECT osm_id, zip_code, canonical_key, housenumber, street, lat, lon, kind,
                   {housenumber_norm_sql("housenumber")} AS housenumber_norm
            FROM _bl_keyed
            WHERE canonical_key != ''
        ),
        -- Deterministic pick per (zip, canonical_key, housenumber_norm):
        -- prefer way over node (way = polygon centroid > doorway point);
        -- on ties (multiple ways for the same canonical address — rare but
        -- happens when OSM tags two polygons with the same addr:housenumber),
        -- break by osm_id ASC. Without the osm_id tiebreaker, arg_max picks
        -- arbitrarily and the chosen lat/lon can shift between runs.
        ranked AS (
            SELECT *,
                ROW_NUMBER() OVER (
                    PARTITION BY zip_code, canonical_key, housenumber_norm
                    ORDER BY (kind = 'way') DESC, osm_id
                ) AS rn
            FROM keyed_norm
        ),
        agg AS (
            SELECT zip_code, canonical_key, housenumber_norm,
                   housenumber, lat AS osm_lat, lon AS osm_lon, street
            FROM ranked
            WHERE rn = 1
        ),
        in_complex AS (
            SELECT DISTINCT a.zip_code, a.canonical_key, a.housenumber_norm
            FROM agg a
            JOIN {res} r
              ON ST_Contains(r.geom, ST_Point(a.osm_lon, a.osm_lat))
        )
        SELECT a.zip_code, a.canonical_key, a.housenumber, a.housenumber_norm,
               a.street, a.osm_lat, a.osm_lon,
               c.zip_code IS NOT NULL AS in_residential_complex
        FROM agg a
        LEFT JOIN in_complex c
          USING (zip_code, canonical_key, housenumber_norm)
    """)
    n = conn.execute(f"SELECT count(*) FROM {fqn}").fetchone()[0]
    print(f"  {n:,} buildings keyed in {time.time() - t0:.1f}s")

    return TableRef(catalog=GEO_CATALOG, schema=OSM_SCHEMA, table=table, version=_current_version(conn))
