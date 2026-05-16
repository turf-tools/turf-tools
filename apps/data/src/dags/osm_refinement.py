"""Hamilton graph for OSM-based refinement of TIGER-geocoded positions.

Sits as a refinement layer on top of the TIGER pipeline. Every voter
is first matched and positioned by TIGER. OSM is then used to shift
each voter along their matched TIGER blockface to a more accurate
fraction — projecting the OSM-known building centroid onto the
blockface — while keeping the perpendicular sidewalk offset from TIGER.

Pipeline:

    osm_pbf  ─►  osm_addresses          (raw vertex-mean lat/lon per
                                         addressed OSM element)

    osm_pbf  ─►  osm_landuse_residential (assembled landuse polygons,
                                          consumed by complex-override
                                          step — planned, not in this
                                          commit)

    persons_best_match
    persons_decomposed
    osm_addresses
    address_tokens   ─►  refined_positions  (per voter: lat/lon)

Position rule (per voter):
  - Match voter to OSM by exact (zip5, canonical_key, housenumber).
  - If matched, fraction = ST_LineLocatePoint(blockface, OSM centroid).
  - Else, fraction = DENSE_RANK among voters on the same blockface.
  - Final position = ST_LineInterpolatePoint(blockface, fraction) + 7m
    perpendicular offset to the correct side of the street.

The canonical_key is the sorted distinctive (non-generic) street-name
tokens after equivalency expansion via `address_tokens`. Same key on
both sides → strict text match → no cross-street collisions.
"""

import json
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

import duckdb
from src.address_tokens import GENERIC_STREET_TOKENS
from src.models import TableRef
from src.osm_normalizations import OSM_STREET_REWRITES
from src.tables import PERSON_CATALOG, ensure_org_schema, org_fqn

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


def _person_current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {PERSON_CATALOG}.current_snapshot()").fetchone()[0]


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
# Node 4 – per-voter refined position
# ---------------------------------------------------------------------------


def refined_positions(
    persons_best_match: TableRef,
    persons_decomposed: TableRef,
    blockface_final: TableRef,
    osm_addresses: TableRef,
    osm_landuse_residential: TableRef,
    address_tokens: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Per-voter (latitude, longitude, position_source).

    Position rule:
      1. Match the voter to an OSM address by exact
         `(zip5, canonical_key, housenumber)`. Pick the way variant
         over a node variant when both exist (way = building polygon
         centroid; node = doorway).
      2. If matched AND the building centroid is inside an OSM
         `landuse=residential` polygon (Co-op City, Stuy Town, …),
         use the OSM centroid directly — no road projection, no
         perpendicular offset.
      3. Else if matched: `fraction = ST_LineLocatePoint(blockface, OSM)`
         projects the OSM-known building centroid onto the TIGER
         blockface to give the position along the road.
      4. Else: `fraction = rank / (max_rank + 1)` via DENSE_RANK
         ordering by (housenumber, half_code) — the original TIGER
         linear-ramp behavior.
      5. Road-projected positions get a 7 m perpendicular offset and
         a 1D shove so distinct buildings stay ≥ 4 m apart.

    `position_source` is one of:
      - `osm_complex` — OSM centroid, inside a residential complex
      - `osm_matched` — fraction from OSM projection onto the blockface
      - `tiger_only` — fraction from DENSE_RANK fallback

    Non-incremental: drops + recreates every run. Same reason as the
    legacy `interpolated_coords` — DENSE_RANK is a window over the
    full blockface, so new voters shift everyone else's rank.
    """
    table_suffix = "refined_positions"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table_suffix)

    pbm = persons_best_match.fqn
    pd_ = persons_decomposed.fqn
    bf_ = blockface_final.fqn
    osm = osm_addresses.fqn
    tok = address_tokens.fqn
    res = osm_landuse_residential.fqn

    conn.execute(f"DROP TABLE IF EXISTS {fqn}")

    # Step A: derive canonical_key + housenumber_str for every OSM
    # address. Tokenize the street, equivalency-expand via address_tokens,
    # drop generic tokens, sort, join with '|'.
    print("refined_positions: keying OSM addresses…")
    t0 = time.time()
    # Apply OSM_STREET_REWRITES (see src/osm_normalizations.py) so OSM's
    # surface form lines up with TIGER's tokenization before we tokenize.
    street_expr = "lower(trim(street))"
    for pat, rep in OSM_STREET_REWRITES:
        pat_sql = pat.replace("'", "''")
        rep_sql = rep.replace("'", "''")
        street_expr = f"regexp_replace({street_expr}, '{pat_sql}', '{rep_sql}', 'g')"
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _osm_raw_tokens AS
        SELECT
            osm_id, kind, housenumber, zip_code, lat, lon,
            list_distinct(list_sort(list_filter(
                list_concat(
                    list_concat(
                        regexp_split_to_array({street_expr}, '[^a-z0-9]+'),
                        regexp_extract_all({street_expr}, '[0-9]+')
                    ),
                    regexp_extract_all({street_expr}, '\\b[a-z]+')
                ),
                x -> length(x) > 0
            ))) AS raw_tokens
        FROM {osm}
        WHERE zip_code IS NOT NULL
          AND street   IS NOT NULL
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _osm_keyed AS
        WITH extras AS (
            SELECT b.osm_id, flatten(list(t.equivalent_tokens)) AS extra
            FROM _osm_raw_tokens b
            JOIN {tok} t ON len(list_intersect(b.raw_tokens, t.equivalent_tokens)) > 0
            GROUP BY b.osm_id
        ),
        combined AS (
            SELECT
                b.osm_id, b.kind, b.housenumber, b.zip_code, b.lat, b.lon,
                list_distinct(list_concat(b.raw_tokens, COALESCE(e.extra, []))) AS expanded
            FROM _osm_raw_tokens b LEFT JOIN extras e USING (osm_id)
        )
        SELECT osm_id, kind, housenumber, zip_code, lat, lon,
               array_to_string(
                   list_sort(list_filter(expanded,
                       t -> NOT list_contains({_GENERIC_SQL}, t))),
                   '|'
               ) AS canonical_key
        FROM combined
        WHERE expanded IS NOT NULL
    """)
    # If both a way and a node exist for the same (zip, key, housenum),
    # prefer the way (polygon centroid > doorway point). Flag buildings
    # whose centroid is inside a landuse=residential polygon — those
    # voters get the OSM centroid directly without road projection.
    # housenumber_norm: strip leading zeros after hyphens (Queens
    # "132-01" → "132-1") then strip hyphens (Manhattan "11-15" → "1115").
    # Matches voter-side normalization in _voter_keyed.
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _osm_lookup AS
        SELECT b.zip_code, b.canonical_key, b.housenumber,
               regexp_replace(
                   regexp_replace(b.housenumber, '(^|-)0*([0-9])', '\\1\\2', 'g'),
                   '-', '', 'g'
               ) AS housenumber_norm,
               b.osm_lat, b.osm_lon,
               EXISTS (
                   SELECT 1 FROM {res} r
                   WHERE ST_Contains(r.geom, ST_Point(b.osm_lon, b.osm_lat))
               ) AS in_residential_complex
        FROM (
            SELECT zip_code, canonical_key, housenumber,
                   arg_max(lat, kind = 'way') AS osm_lat,
                   arg_max(lon, kind = 'way') AS osm_lon
            FROM _osm_keyed
            WHERE canonical_key != ''
            GROUP BY 1, 2, 3
        ) b
    """)
    n_osm = conn.execute("SELECT count(*) FROM _osm_lookup").fetchone()[0]
    print(f"  {n_osm:,} OSM lookup rows in {time.time()-t0:.1f}s")

    # Step B: derive the same canonical_key + housenumber_str for each voter.
    print("  keying voters + joining…")
    t0 = time.time()
    # Use blockface_final.street_name_tokens for the canonical_key —
    # those are already equivalency-expanded by tiger.address_tokens
    # upstream (st↔street↔saint, 1↔1st↔first, etc.), so they match
    # the same canonical form derived on the OSM side.
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _bf_for_voters AS
        SELECT DISTINCT ON (blockface_id) blockface_id, street_name_tokens
        FROM {bf_}
        WHERE geom IS NOT NULL
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _voter_keyed AS
        SELECT
            m.external_id, m.blockface_id, m.geom AS bf_geom, m.side AS bf_side,
            m.person_house_number,
            COALESCE(d.half_code, '') AS half_code,
            d.zip5,
            array_to_string(
                list_sort(list_filter(b.street_name_tokens,
                    t -> NOT list_contains({_GENERIC_SQL}, t))),
                '|'
            ) AS canonical_key,
            COALESCE(d.house_num_prefix, '')
              || CAST(d.house_number AS VARCHAR)
              || CASE WHEN d.half_code IS NOT NULL AND d.half_code != ''
                      THEN ' ' || d.half_code ELSE '' END AS housenumber_str,
            regexp_replace(
                regexp_replace(
                    COALESCE(d.house_num_prefix, '')
                      || CAST(d.house_number AS VARCHAR)
                      || CASE WHEN d.half_code IS NOT NULL AND d.half_code != ''
                              THEN ' ' || d.half_code ELSE '' END,
                    '(^|-)0*([0-9])', '\\1\\2', 'g'),
                '-', '', 'g'
            ) AS housenumber_norm
        FROM {pbm} m
        JOIN {pd_} d        ON d.external_id  = m.external_id
        JOIN _bf_for_voters b ON b.blockface_id = m.blockface_id
    """)

    # Hash join on (zip, canonical_key, housenumber_str) — strict equality.
    # When the voter has a half_code, the joined OSM housenumber must also
    # carry that suffix; OSM rarely tags half-codes, so half-coded voters
    # mostly fall back to the DENSE_RANK ramp (which orders by half_code,
    # so 47 and 47-1/2 still get distinct positions).
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE _voter_with_osm AS
        SELECT v.*, o.osm_lat, o.osm_lon,
               COALESCE(o.in_residential_complex, false) AS in_complex
        FROM _voter_keyed v
        LEFT JOIN _osm_lookup o
          ON o.zip_code         = v.zip5
         AND o.canonical_key    = v.canonical_key
         AND o.housenumber_norm = v.housenumber_norm
    """)
    n_matched = conn.execute("""
        SELECT count(*) FROM _voter_with_osm WHERE osm_lat IS NOT NULL
    """).fetchone()[0]
    n_total = conn.execute("SELECT count(*) FROM _voter_with_osm").fetchone()[0]
    print(f"  {n_matched:,}/{n_total:,} voters got an OSM match "
          f"({100.0 * n_matched / max(n_total, 1):.1f}%) in {time.time()-t0:.1f}s")

    # Step C: compute fraction per voter — OSM projection where matched,
    # DENSE_RANK ramp otherwise.
    print("  computing fractions + final positions…")
    t0 = time.time()
    # All math in UTM-18N. ST_LineLocatePoint in geographic degrees gives
    # a non-perpendicular foot on non-cardinal streets — the rotated
    # grid skews along-street by up to ~20% of the perpendicular offset.
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        WITH ranked AS (
            SELECT v.*,
                DENSE_RANK() OVER (
                    PARTITION BY v.blockface_id
                    ORDER BY v.person_house_number, v.half_code
                ) AS house_rank
            FROM _voter_with_osm v
            WHERE NOT v.in_complex
        ),
        fracced AS (
            SELECT *,
                MAX(house_rank) OVER (PARTITION BY blockface_id) AS max_rank
            FROM ranked
        ),
        projected AS (
            SELECT external_id, blockface_id, bf_side,
                ST_Transform(bf_geom, 'OGC:CRS84', 'EPSG:32618') AS bf_m,
                CASE WHEN osm_lat IS NOT NULL
                     THEN ST_Transform(ST_Point(osm_lon, osm_lat),
                                       'OGC:CRS84', 'EPSG:32618')
                     ELSE NULL
                END AS osm_pt_m,
                house_rank, max_rank
            FROM fracced
        ),
        located AS (
            -- osm_frac = 0 or 1 means the centroid projects beyond the
            -- blockface endpoints (TIGER fragments streets into short
            -- segments). Fall back to the rank ramp so adjacent houses
            -- don't all stack at the clamp point.
            SELECT *,
                CASE WHEN osm_pt_m IS NOT NULL
                     THEN ST_LineLocatePoint(bf_m, osm_pt_m)
                     ELSE NULL
                END AS osm_frac
            FROM projected
        ),
        with_frac AS (
            SELECT external_id, blockface_id, bf_side, bf_m,
                CASE WHEN osm_frac > 0.0 AND osm_frac < 1.0
                     THEN 'osm_matched' ELSE 'tiger_only'
                END AS position_source,
                LEAST(GREATEST(
                    CASE WHEN osm_frac > 0.0 AND osm_frac < 1.0
                         THEN osm_frac
                         ELSE house_rank::DOUBLE / (1 + max_rank)
                    END,
                    0.05
                ), 0.95) AS frac
            FROM located
        ),
        shoved AS (
            -- 1D shove in building space: keep distinct buildings at
            -- least 4 m apart along the line. DENSE_RANK groups voters
            -- that share a frac (same OSM centroid, or same TIGER rank)
            -- into one slot so apartment buildings stay anchored.
            -- sep_frac shrinks when there are more buildings than fit
            -- at 4 m so overflow doesn't pile at the 0.95 cap (Co-op
            -- City: 16 numbered towers on a 21.7 m blockface).
            SELECT external_id, bf_side, bf_m, position_source,
                LEAST(GREATEST(
                    MAX(frac - rn * sep_frac)
                        OVER (PARTITION BY blockface_id, bf_side
                              ORDER BY rn)
                      + rn * sep_frac,
                    0.05
                ), 0.95) AS frac
            FROM (
                SELECT *,
                    LEAST(4.0, 0.9 * bf_len_m / GREATEST(n_buildings, 1))
                      / NULLIF(bf_len_m, 0) AS sep_frac
                FROM (
                    SELECT *,
                        MAX(rn) OVER (PARTITION BY blockface_id, bf_side)
                            AS n_buildings
                    FROM (
                        SELECT *,
                            DENSE_RANK() OVER (PARTITION BY blockface_id,
                                                            bf_side
                                               ORDER BY frac) AS rn,
                            ST_Length(bf_m) AS bf_len_m
                        FROM with_frac
                    )
                )
            )
        ),
        offset_geom AS (
            SELECT external_id, bf_side, position_source,
                ST_LineInterpolatePoint(bf_m, frac) AS pt_m,
                ST_X(ST_LineInterpolatePoint(bf_m, LEAST(frac + 0.01, 1.0)))
                  - ST_X(ST_LineInterpolatePoint(bf_m, frac)) AS dx_m,
                ST_Y(ST_LineInterpolatePoint(bf_m, LEAST(frac + 0.01, 1.0)))
                  - ST_Y(ST_LineInterpolatePoint(bf_m, frac)) AS dy_m
            FROM shoved
        ),
        final_geom AS (
            SELECT external_id, position_source,
                ST_Transform(
                  CASE WHEN sqrt(dx_m * dx_m + dy_m * dy_m) > 0 THEN
                    ST_Translate(pt_m,
                      7.0 * CASE WHEN bf_side = 'left' THEN -dy_m ELSE  dy_m END
                            / sqrt(dx_m * dx_m + dy_m * dy_m),
                      7.0 * CASE WHEN bf_side = 'left' THEN  dx_m ELSE -dx_m END
                            / sqrt(dx_m * dx_m + dy_m * dy_m)
                    )
                  ELSE pt_m
                  END,
                  'EPSG:32618', 'OGC:CRS84'
                ) AS pt_4326
            FROM offset_geom
        )
        SELECT external_id,
               ST_Y(pt_4326) AS latitude,
               ST_X(pt_4326) AS longitude,
               position_source
        FROM final_geom
        UNION ALL
        SELECT external_id,
               osm_lat  AS latitude,
               osm_lon  AS longitude,
               'osm_complex' AS position_source
        FROM _voter_with_osm
        WHERE in_complex
    """)
    print(f"  done in {time.time()-t0:.1f}s")

    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table_suffix,
        version=_person_current_version(conn),
    )
