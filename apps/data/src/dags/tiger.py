"""Prepare TIGER reference data for address matching.

Downloads TIGER/Line shapefiles for the counties an import's addresses fall
in (`geo_extent`) and produces a normalized, query-ready blockface table.
All output lives in the ``ducklake_geo`` catalog, shared across orgs: each
county is fetched once and serves every later import that touches it.

    persons_validated + zcta_counties ─► geo_extent
                                             │
    tiger_addrfeat_raw ─┐                    ▼ (counties to fetch)
                        ├─► blockface_unpivoted ─► blockface_normalized ─► blockface_final
    tiger_edges_raw    ─┘                                                   ▲
    address_tokens ─────────────────────────────────────────────────────────┘
"""

import json
import time
import urllib.request
from pathlib import Path
from zipfile import ZipFile

import duckdb
from src.addressing import EQUIVALENT_TOKEN_GROUPS, tokenize_street_sql
from src.models import GeoExtent, TableRef
from src.projection import utm_crs_sql

GEO_CATALOG = "ducklake_geo"
TIGER_SCHEMA = "tiger"
CENSUS_BASE_URL = "https://www2.census.gov/geo/tiger"
# 2020 ZCTA-to-county relationship file. ZCTAs are redrawn only each decennial
# census, so this vintage holds until 2030's.
ZCTA_COUNTY_URL = "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt"
# USPS state abbreviation → state FIPS: the 50 states, DC, and Puerto Rico.
STATE_FIPS: dict[str, str] = {
    "AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06", "CO": "08", "CT": "09", "DE": "10",
    "DC": "11", "FL": "12", "GA": "13", "HI": "15", "ID": "16", "IL": "17", "IN": "18", "IA": "19",
    "KS": "20", "KY": "21", "LA": "22", "ME": "23", "MD": "24", "MA": "25", "MI": "26", "MN": "27",
    "MS": "28", "MO": "29", "MT": "30", "NE": "31", "NV": "32", "NH": "33", "NJ": "34", "NM": "35",
    "NY": "36", "NC": "37", "ND": "38", "OH": "39", "OK": "40", "OR": "41", "PA": "42", "RI": "44",
    "SC": "45", "SD": "46", "TN": "47", "TX": "48", "UT": "49", "VT": "50", "VA": "51", "WA": "53",
    "WV": "54", "WI": "55", "WY": "56", "PR": "72",
}  # fmt: skip


def _fqn(table: str) -> str:
    """Return the fully qualified name (fqn) for a TIGER table.

    Example: ``ducklake_geo.tiger.blockface_final`` instead of just ``blockface_final``.
    """
    return f"{GEO_CATALOG}.{TIGER_SCHEMA}.{table}"


def _ensure_schema(conn: duckdb.DuckDBPyConnection) -> None:
    """Create the tiger schema in ducklake_geo if it doesn't already exist."""
    conn.execute(f"CREATE SCHEMA IF NOT EXISTS {GEO_CATALOG}.{TIGER_SCHEMA}")


def _current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {GEO_CATALOG}.current_snapshot()").fetchone()[0]


def _download(url: str, path: Path) -> None:
    """Download *url* to *path*. No-ops if *path* already exists on disk (i.e. a
    prior successful download)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        return
    # Census's Cloudflare edge rejects the default Python-urllib UA
    # and caches the HTML rejection at the edge URL-keyed; the unique
    # query param bypasses that cache. Census ignores unknown params.
    fetch_url = f"{url}?_={int(time.time() * 1000)}"
    req = urllib.request.Request(fetch_url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp, open(path, "wb") as f:  # noqa: S310
        f.write(resp.read())


def _download_and_extract(url: str, zip_path: Path, extract_dir: Path) -> None:
    """Download a zip from *url* to *zip_path* (if not already on disk) and
    extract into *extract_dir*."""
    extract_dir.mkdir(parents=True, exist_ok=True)
    _download(url, zip_path)
    with ZipFile(zip_path) as zf:
        zf.extractall(extract_dir)


def _shp_files(directory: Path, pattern: str) -> list[Path]:
    """Return all .shp files in *directory* matching *pattern*."""
    return sorted(directory.glob(pattern))


# ---------------------------------------------------------------------------
# Node 0 – the import's geographic extent
# ---------------------------------------------------------------------------


def zcta_counties(tiger_data_dir: str, conn: duckdb.DuckDBPyConnection) -> TableRef:
    """Census ZIP code tabulation area → county crosswalk, one row per ZCTA and
    county it overlaps on land. A ZCTA straddling a county line maps to each
    county it touches.

    Static: loaded once, skipped when the table already has rows.
    """
    table = "zcta_counties"
    fqn = _fqn(table)

    _ensure_schema(conn)
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            zcta        VARCHAR,
            state_fips  VARCHAR,
            county_fips VARCHAR
        )
    """)
    if conn.execute(f"SELECT count(*) FROM {fqn}").fetchone()[0] > 0:
        return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=_current_version(conn))

    path = Path(tiger_data_dir) / "zcta" / ZCTA_COUNTY_URL.rsplit("/", 1)[-1]
    _download(ZCTA_COUNTY_URL, path)
    # County-only rows (counties no ZCTA overlaps) carry a blank ZCTA.
    conn.execute(f"""
        INSERT INTO {fqn}
        SELECT DISTINCT
            GEOID_ZCTA5_20                    AS zcta,
            substr(GEOID_COUNTY_20, 1, 2)     AS state_fips,
            substr(GEOID_COUNTY_20, 3, 3)     AS county_fips
        FROM read_csv('{path}', delim = '|', header = true, all_varchar = true)
        WHERE GEOID_ZCTA5_20 IS NOT NULL
          AND CAST(AREALAND_PART AS BIGINT) > 0
    """)
    return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=_current_version(conn))


def geo_extent(
    persons_validated: TableRef,
    zcta_counties: TableRef,
    conn: duckdb.DuckDBPyConnection,
) -> GeoExtent:
    """The counties the import's addresses fall in, read off the addresses
    before anything is geocoded.

    A row with a `county_fips` (5-digit, e.g. `36061`) uses that county.
    Rows without one fall back to their (state, ZIP): the counties
    that ZIP overlaps within that state. A ZIP straddling a county line
    brings in every county it touches, since the ZIP alone can't say which
    side a voter lives on, and scoping to the row's state keeps a mistyped
    ZIP from another state from pulling in that state's reference data.
    ZIPs with no ZCTA (PO-box and single-building ZIPs) add no county;
    addresses there have no TIGER street to match anyway.
    """
    persons = persons_validated.fqn
    crosswalk = zcta_counties.fqn
    states = ", ".join(f"('{abbr}', '{fips}')" for abbr, fips in STATE_FIPS.items())
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _extent_addresses AS
        WITH known_counties AS (
            SELECT DISTINCT state_fips || county_fips AS county_fips FROM {crosswalk}
        )
        SELECT a.zip5, s.state_fips, k.county_fips, count(*) AS persons
        FROM (SELECT zip5, upper(trim(state)) AS state, county_fips FROM {persons}) a
        LEFT JOIN (VALUES {states}) s(state, state_fips) USING (state)
        LEFT JOIN known_counties k USING (county_fips)
        GROUP BY ALL
    """)
    counties = conn.execute(f"""
        SELECT substr(county_fips, 1, 2), substr(county_fips, 3, 3)
        FROM _extent_addresses
        WHERE county_fips IS NOT NULL
        UNION
        SELECT z.state_fips, z.county_fips
        FROM _extent_addresses a
        JOIN {crosswalk} z ON z.zcta = a.zip5 AND z.state_fips = a.state_fips
        WHERE a.county_fips IS NULL
        ORDER BY 1, 2
    """).fetchall()
    if not counties:
        raise ValueError(
            "None of the import's addresses have a known county or a ZIP code inside their state's "
            "Census ZIP code areas, so there's no street data to geocode against."
        )
    unplaced = conn.execute(f"""
        SELECT coalesce(sum(persons), 0) FROM _extent_addresses a
        WHERE a.county_fips IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM {crosswalk} z WHERE z.zcta = a.zip5 AND z.state_fips = a.state_fips
          )
    """).fetchone()[0]
    print(f"Geo extent: {len(counties)} counties; {unplaced:,} people with neither a known county nor a ZIP code area")
    return GeoExtent(counties=tuple((state, county) for state, county in counties))


# ---------------------------------------------------------------------------
# Node 1 – raw addrfeat
# ---------------------------------------------------------------------------


def tiger_addrfeat_raw(
    tiger_year: str,
    geo_extent: GeoExtent,
    tiger_data_dir: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Download TIGER addrfeat shapefiles and load into ducklake_geo.tiger.addrfeat.

    The addrfeat (Address Range Features) table contains house-number ranges on
    both sides of each street segment plus ZIP codes — the essential inputs for
    geocoding via linear interpolation.

    Incremental: rows are only inserted when the (tiger_line_id, state_fips,
    county_fips) triple is not already present, so re-running for a superset of
    counties is safe.
    """
    table = "addrfeat"
    fqn = _fqn(table)
    data_dir = Path(tiger_data_dir) / "addrfeat"

    _ensure_schema(conn)
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            tiger_line_id       VARCHAR,
            full_name           VARCHAR,
            left_from_house_num VARCHAR,
            left_to_house_num   VARCHAR,
            right_from_house_num VARCHAR,
            right_to_house_num  VARCHAR,
            left_zip_code       VARCHAR,
            right_zip_code      VARCHAR,
            street_name_tokens  VARCHAR[],
            state_fips          VARCHAR,
            county_fips         VARCHAR,
            geom                GEOMETRY
        )
    """)

    for state, county in geo_extent.counties:
        # Skip if this county is already loaded.
        existing = conn.execute(
            f"SELECT count(*) FROM {fqn} WHERE state_fips = ? AND county_fips = ?",
            [state, county],
        ).fetchone()[0]
        if existing > 0:
            continue

        filename = f"tl_{tiger_year}_{state}{county}_addrfeat.zip"
        url = f"{CENSUS_BASE_URL}/TIGER{tiger_year}/ADDRFEAT/{filename}"
        zip_path = data_dir / filename
        extract_dir = data_dir / f"{state}{county}"

        _download_and_extract(url, zip_path, extract_dir)

        for shp in _shp_files(extract_dir, "*.shp"):
            conn.execute(f"""
                INSERT INTO {fqn}
                SELECT
                    TLID                                    AS tiger_line_id,
                    FULLNAME                                AS full_name,
                    LFROMHN                                 AS left_from_house_num,
                    LTOHN                                   AS left_to_house_num,
                    RFROMHN                                 AS right_from_house_num,
                    RTOHN                                   AS right_to_house_num,
                    ZIPL                                    AS left_zip_code,
                    ZIPR                                    AS right_zip_code,
                    {tokenize_street_sql("FULLNAME")}                AS street_name_tokens,
                    '{state}'                              AS state_fips,
                    '{county}'                             AS county_fips,
                    geom
                FROM ST_Read('{shp}')
            """)

    version = _current_version(conn)
    return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=version)


# ---------------------------------------------------------------------------
# Node 2 – raw edges
# ---------------------------------------------------------------------------


def tiger_edges_raw(
    tiger_year: str,
    geo_extent: GeoExtent,
    tiger_data_dir: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Download TIGER edges shapefiles and load into ducklake_geo.tiger.edges.

    The edges table provides the topological node identifiers (TNIDF / TNIDT)
    needed to stitch blockface segments together into a network, as well as the
    line geometry used for coordinate interpolation.

    Incremental: skips counties already loaded.
    """
    table = "edges"
    fqn = _fqn(table)
    data_dir = Path(tiger_data_dir) / "edges"

    _ensure_schema(conn)
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            tiger_line_id       VARCHAR,
            full_name           VARCHAR,
            feature_class_code  VARCHAR,
            from_node_id        VARCHAR,
            to_node_id          VARCHAR,
            street_name_tokens  VARCHAR[],
            state_fips          VARCHAR,
            county_fips         VARCHAR,
            geom                GEOMETRY
        )
    """)

    for state, county in geo_extent.counties:
        existing = conn.execute(
            f"SELECT count(*) FROM {fqn} WHERE state_fips = ? AND county_fips = ?",
            [state, county],
        ).fetchone()[0]
        if existing > 0:
            continue

        filename = f"tl_{tiger_year}_{state}{county}_edges.zip"
        url = f"{CENSUS_BASE_URL}/TIGER{tiger_year}/EDGES/{filename}"
        zip_path = data_dir / filename
        extract_dir = data_dir / f"{state}{county}"

        _download_and_extract(url, zip_path, extract_dir)

        for shp in _shp_files(extract_dir, "*.shp"):
            conn.execute(f"""
                INSERT INTO {fqn}
                SELECT
                    TLID                                    AS tiger_line_id,
                    FULLNAME                                AS full_name,
                    MTFCC                                   AS feature_class_code,
                    TNIDF                                   AS from_node_id,
                    TNIDT                                   AS to_node_id,
                    {tokenize_street_sql("FULLNAME")}                AS street_name_tokens,
                    '{state}'                              AS state_fips,
                    '{county}'                             AS county_fips,
                    geom
                FROM ST_Read('{shp}')
            """)

    version = _current_version(conn)
    return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=version)


# ---------------------------------------------------------------------------
# Node 2.5 – raw tabblock polygons
# ---------------------------------------------------------------------------


def tiger_tabblock_raw(
    tiger_year: str,
    geo_extent: GeoExtent,
    tiger_data_dir: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Download TIGER TABBLOCK20 shapefiles and load into ducklake_geo.tiger.tabblock.

    Tabblock20 is the polygon geometry for every census block — the
    smallest standard areal unit in TIGER. Used by the boundaries graph
    to derive per-key polygons (ED, ZIP, …) by unioning the blocks where
    voters tagged with each key live, instead of ingesting external
    boundary shapefiles.

    Unlike addrfeat/edges, tabblock is published per-state, not
    per-county. We download each state's full file once and filter rows
    to the extent's counties on insert.

    Incremental: skips counties already loaded.
    """
    table = "tabblock"
    fqn = _fqn(table)
    data_dir = Path(tiger_data_dir) / "tabblock"

    _ensure_schema(conn)

    # Schema migration: a pre-2026-04 tabblock lacks `land_area`,
    # which the boundaries graph needs to filter water-only blocks
    # out of gap-filling. Drop & re-ingest if the column's missing —
    # cheap (~40K rows for NYC, zip cache hot).
    try:
        cols = {c[0] for c in conn.execute(f"DESCRIBE {fqn}").fetchall()}
        if "land_area" not in cols:
            conn.execute(f"DROP TABLE {fqn}")
    except duckdb.CatalogException:
        pass  # table doesn't exist yet — fresh install

    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            block_geoid    VARCHAR,
            state_fips     VARCHAR,
            county_fips    VARCHAR,
            land_area      BIGINT,
            geom           GEOMETRY
        )
    """)

    counties_to_load: dict[str, list[str]] = {}
    for state, county in geo_extent.counties:
        existing = conn.execute(
            f"SELECT count(*) FROM {fqn} WHERE state_fips = ? AND county_fips = ?",
            [state, county],
        ).fetchone()[0]
        if existing == 0:
            counties_to_load.setdefault(state, []).append(county)

    for state, counties in counties_to_load.items():
        filename = f"tl_{tiger_year}_{state}_tabblock20.zip"
        url = f"{CENSUS_BASE_URL}/TIGER{tiger_year}/TABBLOCK20/{filename}"
        zip_path = data_dir / filename
        extract_dir = data_dir / state

        _download_and_extract(url, zip_path, extract_dir)

        counties_sql_list = ", ".join(f"'{c}'" for c in counties)
        for shp in _shp_files(extract_dir, "*.shp"):
            conn.execute(f"""
                INSERT INTO {fqn}
                SELECT
                    GEOID20                           AS block_geoid,
                    STATEFP20                         AS state_fips,
                    COUNTYFP20                        AS county_fips,
                    ALAND20                           AS land_area,
                    geom
                FROM ST_Read('{shp}')
                WHERE STATEFP20 = '{state}'
                  AND COUNTYFP20 IN ({counties_sql_list})
            """)

    version = _current_version(conn)
    return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=version)


# ---------------------------------------------------------------------------
# Node 3 – address token equivalency table
# ---------------------------------------------------------------------------


def address_tokens(conn: duckdb.DuckDBPyConnection) -> TableRef:
    """Populate the static address token equivalency table in geo DuckLake.

    Each row is an array of tokens that should be treated as interchangeable
    when matching voter address strings against TIGER street names (e.g.
    ["st", "street"], ["ave", "avenue", "av"]).

    Incremental: inserts nothing if the table already has the expected row count.
    """
    table = "address_tokens"
    fqn = _fqn(table)

    _ensure_schema(conn)
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            equivalent_tokens VARCHAR[]
        )
    """)

    expected = len(EQUIVALENT_TOKEN_GROUPS)
    existing = conn.execute(f"SELECT count(*) FROM {fqn}").fetchone()[0]
    if existing >= expected:
        version = _current_version(conn)
        return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=version)

    # Insert all groups as JSON-serialised arrays so DuckDB parses them correctly.
    groups_json = json.dumps(EQUIVALENT_TOKEN_GROUPS)
    conn.execute(f"""
        INSERT INTO {fqn} (equivalent_tokens)
        SELECT json_extract(value, '$')::VARCHAR[]
        FROM json_each('{groups_json}')
        OFFSET {existing}
    """)

    version = _current_version(conn)
    return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=version)


# ---------------------------------------------------------------------------
# Node 4 – unpivot addrfeat left/right into one row per blockface side
# ---------------------------------------------------------------------------


def blockface_unpivoted(
    tiger_addrfeat_raw: TableRef,
    tiger_edges_raw: TableRef,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Unpivot TIGER addrfeat left/right columns into individual blockface rows.

    Each row in addrfeat (which carries separate left_* and right_* address
    range columns) becomes two rows here — one for each side of the street.
    The edges table is joined on tiger_line_id to obtain the topological node
    IDs (from_node_id / to_node_id) and the line geometry.

    A synthetic ``blockface_id`` of the form ``<tiger_line_id>:<side>`` serves
    as the natural primary key throughout the downstream pipeline.

    Incremental: skips tiger_line_ids already present.
    """
    table = "blockface_unpivoted"
    fqn = _fqn(table)
    addrfeat_fqn = tiger_addrfeat_raw.fqn
    edges_fqn = tiger_edges_raw.fqn

    _ensure_schema(conn)
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            blockface_id        VARCHAR,
            side                VARCHAR,
            raw_from            VARCHAR,
            raw_to              VARCHAR,
            zip_code            VARCHAR,
            full_name           VARCHAR,
            tiger_line_id       VARCHAR,
            street_name_tokens  VARCHAR[],
            from_node_id        VARCHAR,
            to_node_id          VARCHAR,
            geom                GEOMETRY
        )
    """)

    conn.execute(f"""
        INSERT INTO {fqn}
        SELECT
            a.tiger_line_id || ':left'          AS blockface_id,
            'left'                              AS side,
            a.left_from_house_num               AS raw_from,
            a.left_to_house_num                 AS raw_to,
            a.left_zip_code                     AS zip_code,
            a.full_name,
            a.tiger_line_id,
            a.street_name_tokens,
            e.from_node_id,
            e.to_node_id,
            a.geom
        FROM {addrfeat_fqn} a
        LEFT JOIN {edges_fqn} e ON a.tiger_line_id = e.tiger_line_id
        WHERE a.left_from_house_num IS NOT NULL
          AND a.left_from_house_num != ''
          AND a.tiger_line_id NOT IN (SELECT tiger_line_id FROM {fqn})

        UNION ALL

        SELECT
            a.tiger_line_id || ':right'         AS blockface_id,
            'right'                             AS side,
            a.right_from_house_num              AS raw_from,
            a.right_to_house_num                AS raw_to,
            a.right_zip_code                    AS zip_code,
            a.full_name,
            a.tiger_line_id,
            a.street_name_tokens,
            e.from_node_id,
            e.to_node_id,
            a.geom
        FROM {addrfeat_fqn} a
        LEFT JOIN {edges_fqn} e ON a.tiger_line_id = e.tiger_line_id
        WHERE a.right_from_house_num IS NOT NULL
          AND a.right_from_house_num != ''
          AND a.tiger_line_id NOT IN (SELECT tiger_line_id FROM {fqn})
    """)

    version = _current_version(conn)
    return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=version)


# ---------------------------------------------------------------------------
# Node 5 – normalise house numbers
# ---------------------------------------------------------------------------


def blockface_normalized(
    blockface_unpivoted: TableRef,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Normalise raw house number strings into integers with optional prefix.

    Two-step strategy (mirroring blockfaces.ts):

    1. Direct integer cast — handles the common case of plain numeric strings.
    2. Prefix extraction — for hyphenated numbers like "34-1" / "34-98": the
       trailing integer of each end is the comparable house number, and the
       from end's leading part ("34-") is stored as the prefix. A range whose
       ends carry different prefixes ("50-01" to "52-99", ~two dozen in
       Queens) keeps the from end's.

    If any rows remain after both steps an error is raised so that unexpected
    formats surface immediately rather than silently producing NULL coordinates.

    Also derives ``number_type`` (odd / even / mixed) from the parity of the
    from/to house numbers — used as a fast pre-filter during matching.

    Incremental: skips blockface_ids present before this run. Both steps test
    against that one snapshot, so a TIGER line with plain and hyphenated
    ranges loads all of them in the run that first sees it.
    """
    table = "blockface_normalized"
    fqn = _fqn(table)
    raw_fqn = blockface_unpivoted.fqn

    _ensure_schema(conn)
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            blockface_id        VARCHAR,
            side                VARCHAR,
            from_house_num      INTEGER,
            to_house_num        INTEGER,
            house_num_prefix    VARCHAR,
            number_type         VARCHAR,
            zip_code            VARCHAR,
            full_name           VARCHAR,
            tiger_line_id       VARCHAR,
            street_name_tokens  VARCHAR[],
            from_node_id        VARCHAR,
            to_node_id          VARCHAR,
            geom                GEOMETRY
        )
    """)

    conn.execute(f"CREATE OR REPLACE TEMP TABLE _bfn_loaded AS SELECT DISTINCT blockface_id FROM {fqn}")

    # Step 1: rows where both ends parse directly as integers.
    conn.execute(f"""
        INSERT INTO {fqn}
        SELECT
            blockface_id,
            side,
            TRY_CAST(raw_from AS INTEGER)   AS from_house_num,
            TRY_CAST(raw_to   AS INTEGER)   AS to_house_num,
            ''                              AS house_num_prefix,
            CASE
                WHEN TRY_CAST(raw_from AS INTEGER) % 2 = TRY_CAST(raw_to AS INTEGER) % 2
                THEN CASE WHEN TRY_CAST(raw_from AS INTEGER) % 2 = 1 THEN 'odd' ELSE 'even' END
                ELSE 'mixed'
            END                             AS number_type,
            zip_code,
            full_name,
            tiger_line_id,
            street_name_tokens,
            from_node_id,
            to_node_id,
            geom
        FROM {raw_fqn}
        WHERE TRY_CAST(raw_from AS INTEGER) IS NOT NULL
          AND TRY_CAST(raw_to   AS INTEGER) IS NOT NULL
          AND blockface_id NOT IN (SELECT blockface_id FROM _bfn_loaded)
    """)

    # Step 2: rows with a non-numeric part on either end (e.g. "34-1" / "34-98").
    conn.execute(f"""
        INSERT INTO {fqn}
        SELECT
            blockface_id,
            side,
            CAST(regexp_extract(raw_from, '(\\d+)$') AS INTEGER)    AS from_house_num,
            CAST(regexp_extract(raw_to,   '(\\d+)$') AS INTEGER)    AS to_house_num,
            regexp_replace(raw_from, '\\d+$', '')                   AS house_num_prefix,
            CASE
                WHEN CAST(regexp_extract(raw_from, '(\\d+)$') AS INTEGER) % 2
                   = CAST(regexp_extract(raw_to,   '(\\d+)$') AS INTEGER) % 2
                THEN CASE
                         WHEN CAST(regexp_extract(raw_from, '(\\d+)$') AS INTEGER) % 2 = 1
                         THEN 'odd' ELSE 'even'
                     END
                ELSE 'mixed'
            END                                                      AS number_type,
            zip_code,
            full_name,
            tiger_line_id,
            street_name_tokens,
            from_node_id,
            to_node_id,
            geom
        FROM {raw_fqn}
        WHERE (TRY_CAST(raw_from AS INTEGER) IS NULL OR TRY_CAST(raw_to AS INTEGER) IS NULL)
          -- Both ends end in digits (regexp_extract returns '' on no match)
          AND regexp_extract(raw_from, '(\\d+)$') <> ''
          AND regexp_extract(raw_to,   '(\\d+)$') <> ''
          AND blockface_id NOT IN (SELECT blockface_id FROM _bfn_loaded)
    """)

    # Assert no unparseable rows remain (for newly inserted raw rows only).
    bad = conn.execute(f"""
        SELECT raw_from, raw_to, full_name, tiger_line_id
        FROM {raw_fqn}
        WHERE blockface_id NOT IN (SELECT blockface_id FROM {fqn})
        LIMIT 10
    """).fetchall()

    if bad:
        examples = "\n".join(f'  - "{r[0]}" to "{r[1]}" on {r[2]} (TLID: {r[3]})' for r in bad)
        msg = (
            "blockface_normalized: unparseable house numbers found after both "
            "normalisation steps. These rows could not be converted to integers "
            "and don't end in digits.\n\nExamples:\n" + examples
        )
        raise ValueError(msg)

    version = _current_version(conn)
    return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=version)


# ---------------------------------------------------------------------------
# Node 6 – expand street name tokens with equivalency groups
# ---------------------------------------------------------------------------


def blockface_final(
    blockface_normalized: TableRef,
    tiger_addrfeat_raw: TableRef,
    address_tokens: TableRef,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Query-ready blockface table.

    Three transforms on top of ``blockface_normalized``:

    1. **Alias collapse.** TIGER addrfeat sometimes stores the same
       physical blockface under multiple street names (e.g. a street
       and its commemorative co-name) — same ``tiger_line_id``,
       ``side``, prefix, and address range, different ``full_name``.
       ``GROUP BY (tlid, side, prefix, from, to)`` merges these into
       one row. The canonical ``full_name`` is the one that appears
       most often in the line's own county (alphabetical tiebreak). A
       line on a county boundary sits in both counties' files and sums its
       names' counts over each.

       Note: this does *not* collapse rows that share a TIGER line but
       legitimately represent distinct address ranges — those have
       different ``(prefix, from, to)`` triples and stay as separate
       rows.

    2. **Two token sets.** Every group emits:
         - ``street_tokens_match`` — the union of every alias row's
           tokens, equivalency-expanded. Used by the matching
           predicate so a voter using any alias spelling matches.
         - ``street_tokens_lookup`` — only the canonical name's
           tokens, equivalency-expanded. Used by ``refined_positions``
           for the OSM ``canonical_key`` lookup, so voters at the
           same building hit the same OSM record regardless of which
           alias their raw address used.

    3. **Equivalency expansion.** Applied to both token sets via the
       ``address_tokens`` lookup so abbreviations match full forms
       (st↔street, ave↔avenue, 1st↔first, …).

    Also carries ``utm_crs``, the UTM zone of the blockface's line
    (`projection.utm_crs_sql`), which geocoding does its metre math in.

    Non-incremental: the collapse needs to see all rows at once.
    """
    table = "blockface_final"
    fqn = _fqn(table)
    norm_fqn = blockface_normalized.fqn
    addrfeat_fqn = tiger_addrfeat_raw.fqn
    tokens_fqn = address_tokens.fqn

    _ensure_schema(conn)

    conn.execute(f"""
        CREATE OR REPLACE TABLE {fqn} AS
        WITH line_counties AS (
            SELECT DISTINCT tiger_line_id, state_fips, county_fips FROM {addrfeat_fqn}
        ),
        county_name_freq AS (
            SELECT lc.state_fips, lc.county_fips, n.full_name, count(*) AS freq
            FROM {norm_fqn} n
            JOIN line_counties lc USING (tiger_line_id)
            WHERE n.full_name IS NOT NULL
            GROUP BY ALL
        ),
        name_freq AS (
            SELECT ln.tiger_line_id, ln.full_name, sum(f.freq) AS freq
            FROM (SELECT DISTINCT tiger_line_id, full_name FROM {norm_fqn} WHERE full_name IS NOT NULL) ln
            JOIN line_counties lc USING (tiger_line_id)
            JOIN county_name_freq f
              ON f.state_fips = lc.state_fips
             AND f.county_fips = lc.county_fips
             AND f.full_name = ln.full_name
            GROUP BY ALL
        ),
        -- Each blockface_normalized row enriched with the frequency of its
        -- full_name. Used both to rank within a group and to attach the
        -- canonical row's tokens to every member of the group.
        normalized_ranked AS (
            SELECT
                n.tiger_line_id || ':' || n.side                       AS blockface_id,
                n.side, n.from_house_num, n.to_house_num,
                n.house_num_prefix, n.number_type, n.zip_code,
                n.tiger_line_id, n.full_name, n.street_name_tokens,
                n.from_node_id, n.to_node_id, n.geom,
                COALESCE(f.freq, 0)                                    AS name_freq,
                ROW_NUMBER() OVER (
                    PARTITION BY n.tiger_line_id, n.side,
                                 COALESCE(n.house_num_prefix, ''),
                                 n.from_house_num, n.to_house_num
                    ORDER BY COALESCE(f.freq, 0) DESC,
                             n.full_name ASC NULLS LAST
                )                                                       AS canonical_rank
            FROM {norm_fqn} n
            LEFT JOIN name_freq f USING (tiger_line_id, full_name)
        ),
        -- Collapse alias rows by (tlid, side, prefix, from, to). Each
        -- (tlid, side, prefix, range) is one logical blockface; multiple
        -- full_name rows describing it merge here.
        collapsed AS (
            SELECT
                blockface_id, side, from_house_num, to_house_num,
                house_num_prefix, number_type, zip_code, tiger_line_id,
                -- Canonical name = the row with canonical_rank = 1.
                arg_max(full_name, -canonical_rank)                    AS full_name,
                -- Union of every alias row's pre-expansion tokens.
                list_distinct(flatten(list(street_name_tokens)))       AS merged_raw_tokens,
                -- Pre-expansion tokens of just the canonical row.
                arg_max(street_name_tokens, -canonical_rank)           AS canonical_raw_tokens,
                ANY_VALUE(from_node_id)                                AS from_node_id,
                ANY_VALUE(to_node_id)                                  AS to_node_id,
                ANY_VALUE(geom)                                        AS geom,
                ROW_NUMBER() OVER ()                                   AS bf_row
            FROM normalized_ranked
            GROUP BY blockface_id, side, from_house_num, to_house_num,
                     house_num_prefix, number_type, zip_code, tiger_line_id
        ),
        -- Equivalency expansion runs per bf_row (the synthetic group id)
        -- so each `(tlid, side, prefix, from, to)` group gets its own
        -- extras bucket, even when multiple groups share `blockface_id`.
        merged_extras AS (
            SELECT c.bf_row, flatten(list(t.equivalent_tokens)) AS extras
            FROM collapsed c JOIN {tokens_fqn} t
              ON len(list_intersect(c.merged_raw_tokens, t.equivalent_tokens)) > 0
            GROUP BY c.bf_row
        ),
        canonical_extras AS (
            SELECT c.bf_row, flatten(list(t.equivalent_tokens)) AS extras
            FROM collapsed c JOIN {tokens_fqn} t
              ON len(list_intersect(c.canonical_raw_tokens, t.equivalent_tokens)) > 0
            GROUP BY c.bf_row
        )
        SELECT
            c.blockface_id,
            c.side,
            c.from_house_num,
            c.to_house_num,
            c.house_num_prefix,
            c.number_type,
            c.zip_code,
            c.full_name,
            c.tiger_line_id,
            list_distinct(list_concat(c.merged_raw_tokens, COALESCE(m.extras, [])))
                                                                       AS street_tokens_match,
            list_distinct(list_concat(c.canonical_raw_tokens, COALESCE(ce.extras, [])))
                                                                       AS street_tokens_lookup,
            c.from_node_id,
            c.to_node_id,
            c.geom,
            {utm_crs_sql("ST_X(ST_Centroid(c.geom))")}                AS utm_crs
        FROM collapsed c
        LEFT JOIN merged_extras   m  ON m.bf_row = c.bf_row
        LEFT JOIN canonical_extras ce ON ce.bf_row = c.bf_row
    """)

    version = _current_version(conn)
    return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=version)
