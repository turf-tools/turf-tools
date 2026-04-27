"""Hamilton graph for preparing TIGER geographic reference data into geo DuckLake.

This graph downloads US Census TIGER/Line shapefiles for a given state/county
selection, loads them into geo_ducklake, and produces a normalized blockface
table optimised for address matching.

All nodes write to the ``geo_ducklake`` catalog so that the resulting blockface
data is reusable across multiple client voter files without duplication.

Node dependency chain:
    tiger_addrfeat_raw ──┐
                          ├─► blockface_unpivoted ─► blockface_normalized ─► blockface_final
    tiger_edges_raw ─────┘
    address_token_table ─────────────────────────────────────────────────► blockface_final
"""

import json
import urllib.request
from pathlib import Path
from zipfile import ZipFile

import duckdb

from src.address_tokens import EQUIVALENT_TOKEN_GROUPS
from src.models import TableRef

GEO_CATALOG = "geo_ducklake"
TIGER_SCHEMA = "tiger"
CENSUS_BASE_URL = "https://www2.census.gov/geo/tiger"


def _tokenise(col: str) -> str:
    """Return a DuckDB SQL expression that tokenises a street name column.

    Produces a sorted, deduplicated array of lowercase alphanumeric tokens,
    mirroring the approach in old/contracts/tiger.ts.
    """
    return (
        f"list_distinct(list_sort(list_filter("
        f"  list_concat("
        f"    list_concat("
        f"      regexp_split_to_array(lower(trim({col})), '[^a-z0-9]+'),"
        f"      regexp_extract_all(lower(trim({col})), '[0-9]+')"
        f"    ),"
        f"    regexp_extract_all(lower(trim({col})), '\\b[a-z]+')"
        f"  ),"
        f"  x -> length(x) > 0"
        f")))"
    )


def _fqn(table: str) -> str:
    """Return the fully qualified name (fqn) for a TIGER table.

    Example: ``geo_ducklake.tiger.blockface`` instead of just ``blockface``.
    """
    return f"{GEO_CATALOG}.{TIGER_SCHEMA}.{table}"


def _ensure_schema(conn: duckdb.DuckDBPyConnection) -> None:
    """Create the tiger schema in geo_ducklake if it doesn't already exist."""
    conn.execute(f"CREATE SCHEMA IF NOT EXISTS {GEO_CATALOG}.{TIGER_SCHEMA}")


def _current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {GEO_CATALOG}.current_snapshot()").fetchone()[0]


def _download_and_extract(url: str, zip_path: Path, extract_dir: Path) -> None:
    """Download a zip from *url* to *zip_path* and extract into *extract_dir*.

    No-ops if the zip already exists on disk (i.e. a prior successful download).
    """
    if not zip_path.exists():
        extract_dir.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url) as resp, open(zip_path, "wb") as f:  # noqa: S310
            f.write(resp.read())

    with ZipFile(zip_path) as zf:
        zf.extractall(extract_dir)


def _shp_files(directory: Path, pattern: str) -> list[Path]:
    """Return all .shp files in *directory* matching *pattern*."""
    return sorted(directory.glob(pattern))


# ---------------------------------------------------------------------------
# Node 1 – raw addrfeat
# ---------------------------------------------------------------------------


def tiger_addrfeat_raw(
    tiger_year: str,
    tiger_state_fips: str,
    tiger_county_fips: list[str],
    tiger_data_dir: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Download TIGER addrfeat shapefiles and load into geo_ducklake.tiger.addrfeat.

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

    for county in tiger_county_fips:
        # Skip if this county is already loaded.
        existing = conn.execute(
            f"SELECT count(*) FROM {fqn} WHERE state_fips = ? AND county_fips = ?",
            [tiger_state_fips, county],
        ).fetchone()[0]
        if existing > 0:
            continue

        filename = f"tl_{tiger_year}_{tiger_state_fips}{county}_addrfeat.zip"
        url = f"{CENSUS_BASE_URL}/TIGER{tiger_year}/ADDRFEAT/{filename}"
        zip_path = data_dir / filename
        extract_dir = data_dir / f"{tiger_state_fips}{county}"

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
                    {_tokenise("FULLNAME")}                AS street_name_tokens,
                    '{tiger_state_fips}'                   AS state_fips,
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
    tiger_state_fips: str,
    tiger_county_fips: list[str],
    tiger_data_dir: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Download TIGER edges shapefiles and load into geo_ducklake.tiger.edges.

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

    for county in tiger_county_fips:
        existing = conn.execute(
            f"SELECT count(*) FROM {fqn} WHERE state_fips = ? AND county_fips = ?",
            [tiger_state_fips, county],
        ).fetchone()[0]
        if existing > 0:
            continue

        filename = f"tl_{tiger_year}_{tiger_state_fips}{county}_edges.zip"
        url = f"{CENSUS_BASE_URL}/TIGER{tiger_year}/EDGES/{filename}"
        zip_path = data_dir / filename
        extract_dir = data_dir / f"{tiger_state_fips}{county}"

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
                    {_tokenise("FULLNAME")}                AS street_name_tokens,
                    '{tiger_state_fips}'                   AS state_fips,
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
    tiger_state_fips: str,
    tiger_county_fips: list[str],
    tiger_data_dir: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Download TIGER TABBLOCK20 shapefiles and load into geo_ducklake.tiger.tabblock.

    Tabblock20 is the polygon geometry for every census block — the
    smallest standard areal unit in TIGER. Used by the boundaries graph
    to derive per-key polygons (ED, ZIP, …) by unioning the blocks where
    voters tagged with each key live, instead of ingesting external
    boundary shapefiles.

    Unlike addrfeat/edges, tabblock is published per-state, not
    per-county. We download the state's full file once and filter rows
    to the configured counties on insert.

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

    counties_to_load = []
    for county in tiger_county_fips:
        existing = conn.execute(
            f"SELECT count(*) FROM {fqn} WHERE state_fips = ? AND county_fips = ?",
            [tiger_state_fips, county],
        ).fetchone()[0]
        if existing == 0:
            counties_to_load.append(county)

    if not counties_to_load:
        version = _current_version(conn)
        return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=version)

    filename = f"tl_{tiger_year}_{tiger_state_fips}_tabblock20.zip"
    url = f"{CENSUS_BASE_URL}/TIGER{tiger_year}/TABBLOCK20/{filename}"
    zip_path = data_dir / filename
    extract_dir = data_dir / tiger_state_fips

    _download_and_extract(url, zip_path, extract_dir)

    counties_sql_list = ", ".join(f"'{c}'" for c in counties_to_load)
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
            WHERE STATEFP20 = '{tiger_state_fips}'
              AND COUNTYFP20 IN ({counties_sql_list})
        """)

    version = _current_version(conn)
    return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=version)


# ---------------------------------------------------------------------------
# Node 3 – address token equivalency table
# ---------------------------------------------------------------------------


def address_token_table(conn: duckdb.DuckDBPyConnection) -> TableRef:
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
    2. Prefix extraction — for hyphenated numbers like "34-1" / "34-98" where
       the prefix ("34-") is common to both ends; stores prefix separately and
       the trailing integer as the comparable house number.

    If any rows remain after both steps an error is raised so that unexpected
    formats surface immediately rather than silently producing NULL coordinates.

    Also derives ``number_type`` (odd / even / mixed) from the parity of the
    from/to house numbers — used as a fast pre-filter during matching.

    Incremental: skips blockface_ids already present.
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
          AND blockface_id NOT IN (SELECT blockface_id FROM {fqn})
    """)

    # Step 2: rows with a common non-numeric prefix (e.g. "34-1" / "34-98").
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
        WHERE TRY_CAST(raw_from AS INTEGER) IS NULL
           OR TRY_CAST(raw_to   AS INTEGER) IS NULL
          -- Both ends share the same non-numeric prefix
          AND regexp_extract(raw_from, '(\\d+)$') IS NOT NULL
          AND regexp_extract(raw_to,   '(\\d+)$') IS NOT NULL
          AND regexp_replace(raw_from, '\\d+$', '') = regexp_replace(raw_to, '\\d+$', '')
          AND blockface_id NOT IN (SELECT blockface_id FROM {fqn})
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
            "and no common prefix was found.\n\nExamples:\n" + examples
        )
        raise ValueError(msg)

    version = _current_version(conn)
    return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=version)


# ---------------------------------------------------------------------------
# Node 6 – expand street name tokens with equivalency groups
# ---------------------------------------------------------------------------


def blockface_final(
    blockface_normalized: TableRef,
    address_token_table: TableRef,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Produce the query-ready blockface table with expanded street name tokens.

    For each blockface whose ``street_name_tokens`` array intersects any
    equivalency group, the full group's tokens are merged in. For example, a
    blockface with tokens ["broadway", "st"] will also gain "street" so that
    addresses using the full form match correctly.

    This is the stable table that Graph 3 (geocode) reads directly.
    Incremental: skips blockface_ids already present.
    """
    table = "blockface"
    fqn = _fqn(table)
    norm_fqn = blockface_normalized.fqn
    tokens_fqn = address_token_table.fqn

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

    conn.execute(f"""
        INSERT INTO {fqn}
        WITH new_rows AS (
            SELECT * FROM {norm_fqn}
            WHERE blockface_id NOT IN (SELECT blockface_id FROM {fqn})
        ),
        -- Collect all extra tokens per blockface_id (one row per blockface regardless
        -- of how many equivalency groups matched).
        extra_by_blockface AS (
            SELECT
                n.blockface_id,
                flatten(list(t.equivalent_tokens)) AS extra_tokens
            FROM new_rows n
            JOIN {tokens_fqn} t
              ON len(list_intersect(n.street_name_tokens, t.equivalent_tokens)) > 0
            GROUP BY n.blockface_id
        )
        -- Rows that matched at least one token group: merge in the extra tokens.
        SELECT
            n.blockface_id,
            n.side,
            n.from_house_num,
            n.to_house_num,
            n.house_num_prefix,
            n.number_type,
            n.zip_code,
            n.full_name,
            n.tiger_line_id,
            list_distinct(list_concat(n.street_name_tokens, e.extra_tokens)) AS street_name_tokens,
            n.from_node_id,
            n.to_node_id,
            n.geom
        FROM new_rows n
        JOIN extra_by_blockface e ON n.blockface_id = e.blockface_id

        UNION ALL

        -- Rows with no token group overlap keep their original tokens unchanged.
        SELECT
            n.blockface_id,
            n.side,
            n.from_house_num,
            n.to_house_num,
            n.house_num_prefix,
            n.number_type,
            n.zip_code,
            n.full_name,
            n.tiger_line_id,
            n.street_name_tokens,
            n.from_node_id,
            n.to_node_id,
            n.geom
        FROM new_rows n
        WHERE n.blockface_id NOT IN (SELECT blockface_id FROM extra_by_blockface)
    """)

    version = _current_version(conn)
    return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=version)
