"""Prepare TIGER reference data for address matching.

Downloads TIGER/Line shapefiles for the configured state/county
selection and produces a normalized, query-ready blockface table.
All output lives in the ``geo_ducklake`` catalog, shared across orgs.

    tiger_addrfeat_raw ─┐
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
from src.models import TableRef

GEO_CATALOG = "geo_ducklake"
TIGER_SCHEMA = "tiger"
CENSUS_BASE_URL = "https://www2.census.gov/geo/tiger"


def _fqn(table: str) -> str:
    """Return the fully qualified name (fqn) for a TIGER table.

    Example: ``geo_ducklake.tiger.blockface_final`` instead of just ``blockface_final``.
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
    extract_dir.mkdir(parents=True, exist_ok=True)
    if not zip_path.exists():
        # Census's Cloudflare edge rejects the default Python-urllib UA
        # and caches the HTML rejection at the edge URL-keyed; the unique
        # query param bypasses that cache. Census ignores unknown params.
        fetch_url = f"{url}?_={int(time.time() * 1000)}"
        req = urllib.request.Request(fetch_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req) as resp, open(zip_path, "wb") as f:  # noqa: S310
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
                    {tokenize_street_sql("FULLNAME")}                AS street_name_tokens,
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
                    {tokenize_street_sql("FULLNAME")}                AS street_name_tokens,
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
       most often across the dataset (alphabetical tiebreak).

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

    Non-incremental: the collapse needs to see all rows at once.
    """
    table = "blockface_final"
    fqn = _fqn(table)
    norm_fqn = blockface_normalized.fqn
    tokens_fqn = address_tokens.fqn

    _ensure_schema(conn)
    conn.execute(f"DROP TABLE IF EXISTS {fqn}")

    conn.execute(f"""
        CREATE TABLE {fqn} AS
        WITH name_freq AS (
            SELECT full_name, count(*) AS freq
            FROM {norm_fqn}
            WHERE full_name IS NOT NULL
            GROUP BY full_name
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
            LEFT JOIN name_freq f USING (full_name)
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
            c.geom
        FROM collapsed c
        LEFT JOIN merged_extras   m  ON m.bf_row = c.bf_row
        LEFT JOIN canonical_extras ce ON ce.bf_row = c.bf_row
    """)

    version = _current_version(conn)
    return TableRef(catalog=GEO_CATALOG, schema=TIGER_SCHEMA, table=table, version=version)
