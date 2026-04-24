"""Hamilton graph for geocoding voter addresses against TIGER blockface data.

Takes the validated voter data produced by Graph 1 (`voter_file_loader`) and the
blockface reference data produced by Graph 2 (`tiger`) and produces a
geocoded voter table with lat/lon coordinates derived from linear interpolation
along the matching TIGER edge geometry.

Cross-catalog joins are performed on the single shared DuckDB connection which
has both ``ducklake`` (voter data) and ``geo_ducklake`` (TIGER blockfaces)
attached.

Node dependency chain:
    validated_voter_data ─► decomposed_voter_addresses ─► candidate_blockfaces
                                                               │
    blockface_final ──────────────────────────────────────────┘
                                                               │
                                                        scored_matches
                                                               │
                                                         best_match
                                                               │
                                                       geocoded_voters
                                                               │
                                                     geocoding_summary
"""

import duckdb

from src.models import TableRef

VOTER_CATALOG = "ducklake"
VOTER_SCHEMA = "main"
GEO_CATALOG = "geo_ducklake"
TIGER_SCHEMA = "tiger"


def _voter_fqn(client_name: str, table_suffix: str) -> str:
    return f"{VOTER_CATALOG}.{VOTER_SCHEMA}.{client_name}_{table_suffix}"


def _current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {VOTER_CATALOG}.current_snapshot()").fetchone()[0]


# ---------------------------------------------------------------------------
# Node 1 – decompose address_line_1 into matchable parts
# ---------------------------------------------------------------------------


def decomposed_voter_addresses(
    validated_voter_data: TableRef,
    client_name: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Parse voter address strings into structured fields for blockface matching.

    ``address_line_1`` from the Person schema (e.g. "123 N Broadway") is
    split into:
    - ``house_number``      — the leading integer portion
    - ``house_num_prefix``  — any non-numeric prefix preceding the trailing
                              integer (mirrors the TIGER prefix normalisation)
    - ``street_name_raw``   — everything after the house number
    - ``street_name_tokens``— lowercase alphanumeric token array
    - ``number_type``       — "odd" / "even" derived from house_number parity

    ``zip5`` is carried through from the Person schema for the blockface ZIP
    filter.

    Incremental: skips external_ids already present.
    """
    table_suffix = "voters_decomposed"
    fqn = _voter_fqn(client_name, table_suffix)
    source_fqn = validated_voter_data.fqn

    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            external_id         VARCHAR,
            house_number        INTEGER,
            house_num_prefix    VARCHAR,
            street_name_raw     VARCHAR,
            street_name_tokens  VARCHAR[],
            number_type         VARCHAR,
            zip5                VARCHAR
        )
    """)

    conn.execute(f"""
        INSERT INTO {fqn}
        WITH parsed AS (
            SELECT
                external_id,
                zip5,
                address_line_1,
                -- Extract any leading non-numeric prefix from the house number
                -- e.g. "34-12 Broadway" -> prefix="34-", house_num=12
                CASE
                    WHEN regexp_extract(
                            regexp_extract(address_line_1, '^([^\\s]+)'), '(\\d+)$'
                         ) != ''
                    THEN regexp_replace(
                            regexp_extract(address_line_1, '^([^\\s]+)'), '\\d+$', ''
                         )
                    ELSE ''
                END AS house_num_prefix,
                TRY_CAST(
                    regexp_extract(
                        regexp_extract(address_line_1, '^([^\\s]+)'),
                        '(\\d+)$'
                    ) AS INTEGER
                ) AS house_number,
                -- Street name is everything after the first whitespace-delimited token
                trim(substr(address_line_1, length(regexp_extract(address_line_1, '^\\S+')) + 1))
                    AS street_name_raw
            FROM {source_fqn}
            WHERE external_id NOT IN (SELECT external_id FROM {fqn})
        )
        SELECT
            external_id,
            house_number,
            house_num_prefix,
            street_name_raw,
            list_distinct(list_sort(list_filter(
                list_concat(
                    list_concat(
                        regexp_split_to_array(lower(trim(street_name_raw)), '[^a-z0-9]+'),
                        regexp_extract_all(lower(trim(street_name_raw)), '[0-9]+')
                    ),
                    regexp_extract_all(lower(trim(street_name_raw)), '\\b[a-z]+')
                ),
                x -> length(x) > 0
            ))) AS street_name_tokens,
            CASE WHEN house_number % 2 = 1 THEN 'odd' ELSE 'even' END AS number_type,
            zip5
        FROM parsed
        WHERE house_number IS NOT NULL
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=VOTER_CATALOG,
        schema=VOTER_SCHEMA,
        table=f"{client_name}_{table_suffix}",
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 2 – join voters to candidate blockfaces
# ---------------------------------------------------------------------------


def candidate_blockfaces(
    decomposed_voter_addresses: TableRef,
    blockface_final: TableRef,
    client_name: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Match each decomposed voter address to candidate blockfaces.

    Matching criteria (all must hold):
    1. ZIP code equality (fast partition filter)
    2. number_type parity match (odd/even)
    3. House number falls within the blockface address range (either direction)
    4. Token array intersection is non-empty (street name overlap)

    Multiple blockfaces may match a single voter — ``scored_matches`` narrows
    these to the best one.

    Cross-catalog join: voter data in ``ducklake``, blockfaces in
    ``geo_ducklake``. Both catalogs are attached on the same connection.

    Incremental: skips external_ids already present.
    """
    table_suffix = "voters_candidates"
    fqn = _voter_fqn(client_name, table_suffix)
    voters_fqn = decomposed_voter_addresses.fqn
    blockface_fqn = blockface_final.fqn

    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            external_id         VARCHAR,
            blockface_id        VARCHAR,
            tiger_line_id       VARCHAR,
            side                VARCHAR,
            from_house_num      INTEGER,
            to_house_num        INTEGER,
            house_num_prefix    VARCHAR,
            from_node_id        VARCHAR,
            to_node_id          VARCHAR,
            geom                GEOMETRY,
            voter_house_number  INTEGER,
            token_overlap       INTEGER
        )
    """)

    conn.execute(f"""
        INSERT INTO {fqn}
        SELECT
            v.external_id,
            b.blockface_id,
            b.tiger_line_id,
            b.side,
            b.from_house_num,
            b.to_house_num,
            b.house_num_prefix,
            b.from_node_id,
            b.to_node_id,
            b.geom,
            v.house_number                                              AS voter_house_number,
            len(list_intersect(v.street_name_tokens, b.street_name_tokens))
                                                                        AS token_overlap
        FROM {voters_fqn} v
        JOIN {blockface_fqn} b
          ON b.zip_code   = v.zip5
         AND b.number_type IN (v.number_type, 'mixed')
         AND (
               v.house_number BETWEEN b.from_house_num AND b.to_house_num
            OR v.house_number BETWEEN b.to_house_num   AND b.from_house_num
         )
         AND len(list_intersect(v.street_name_tokens, b.street_name_tokens)) >= 2
        WHERE v.external_id NOT IN (SELECT external_id FROM {fqn})
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=VOTER_CATALOG,
        schema=VOTER_SCHEMA,
        table=f"{client_name}_{table_suffix}",
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 3 – score each candidate match
# ---------------------------------------------------------------------------


def scored_matches(
    candidate_blockfaces: TableRef,
    decomposed_voter_addresses: TableRef,
    client_name: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Score each voter–blockface candidate pair for match quality.

    Score components:
    - ``token_overlap``      — raw count of shared street name tokens (already
                               expanded with equivalency groups in blockface_final)
    - ``numeric_token_bonus``— extra point when the overlapping tokens include at
                               least one purely numeric token (e.g. "42" in
                               "42nd St"), reducing false matches on numbered streets

    The combined ``match_score`` is used by ``best_match`` to select the single
    best blockface per voter.

    Incremental: skips external_ids already present.
    """
    table_suffix = "voters_scored"
    fqn = _voter_fqn(client_name, table_suffix)
    candidates_fqn = candidate_blockfaces.fqn
    voters_fqn = decomposed_voter_addresses.fqn

    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            external_id         VARCHAR,
            blockface_id        VARCHAR,
            tiger_line_id       VARCHAR,
            side                VARCHAR,
            from_house_num      INTEGER,
            to_house_num        INTEGER,
            house_num_prefix    VARCHAR,
            from_node_id        VARCHAR,
            to_node_id          VARCHAR,
            geom                GEOMETRY,
            voter_house_number  INTEGER,
            token_overlap       INTEGER,
            numeric_token_bonus INTEGER,
            match_score         INTEGER
        )
    """)

    conn.execute(f"""
        INSERT INTO {fqn}
        SELECT
            c.external_id,
            c.blockface_id,
            c.tiger_line_id,
            c.side,
            c.from_house_num,
            c.to_house_num,
            c.house_num_prefix,
            c.from_node_id,
            c.to_node_id,
            c.geom,
            c.voter_house_number,
            c.token_overlap,
            -- Bonus when the voter address contains a purely numeric token (e.g. "42"
            -- in "42nd St"). This increases score for numbered-street matches,
            -- reducing false positives from short token overlaps on plain street names.
            CASE WHEN len(list_filter(
                v.street_name_tokens,
                t -> regexp_matches(t, '^[0-9]+$')
            )) > 0 THEN 1 ELSE 0 END                                    AS numeric_token_bonus,
            c.token_overlap + CASE WHEN len(list_filter(
                v.street_name_tokens,
                t -> regexp_matches(t, '^[0-9]+$')
            )) > 0 THEN 1 ELSE 0 END                                    AS match_score
        FROM {candidates_fqn} c
        JOIN {voters_fqn} v ON c.external_id = v.external_id
        WHERE c.external_id NOT IN (SELECT external_id FROM {fqn})
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=VOTER_CATALOG,
        schema=VOTER_SCHEMA,
        table=f"{client_name}_{table_suffix}",
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 4 – select best blockface per voter
# ---------------------------------------------------------------------------


def best_match(
    scored_matches: TableRef,
    client_name: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Select the single highest-scoring blockface candidate per voter.

    Uses ROW_NUMBER() partitioned by external_id ordered by match_score DESC.
    Ties are broken arbitrarily (stable within a run via DuckDB's deterministic
    ordering on blockface_id).

    Incremental: skips external_ids already present.
    """
    table_suffix = "voters_best_match"
    fqn = _voter_fqn(client_name, table_suffix)
    scored_fqn = scored_matches.fqn

    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            external_id         VARCHAR,
            blockface_id        VARCHAR,
            tiger_line_id       VARCHAR,
            side                VARCHAR,
            from_house_num      INTEGER,
            to_house_num        INTEGER,
            house_num_prefix    VARCHAR,
            from_node_id        VARCHAR,
            to_node_id          VARCHAR,
            geom                GEOMETRY,
            voter_house_number  INTEGER,
            match_score         INTEGER
        )
    """)

    conn.execute(f"""
        INSERT INTO {fqn}
        SELECT
            external_id,
            blockface_id,
            tiger_line_id,
            side,
            from_house_num,
            to_house_num,
            house_num_prefix,
            from_node_id,
            to_node_id,
            geom,
            voter_house_number,
            match_score
        FROM (
            SELECT
                *,
                ROW_NUMBER() OVER (
                    PARTITION BY external_id
                    ORDER BY match_score DESC, blockface_id
                ) AS rn
            FROM {scored_fqn}
            WHERE external_id NOT IN (SELECT external_id FROM {fqn})
        ) ranked
        WHERE rn = 1
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=VOTER_CATALOG,
        schema=VOTER_SCHEMA,
        table=f"{client_name}_{table_suffix}",
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 5 – interpolate coordinates along blockface geometry
# ---------------------------------------------------------------------------


def geocoded_voters(
    best_match: TableRef,
    validated_voter_data: TableRef,
    client_name: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Produce the final geocoded voter table with lat/lon coordinates.

    For matched voters the coordinate is derived by linear interpolation along
    the TIGER edge geometry:

        fraction = (house_number - range_min) / (range_max - range_min)
        point    = ST_LineInterpolatePoint(geom, LEAST(GREATEST(fraction, 0), 1))

    The fraction is clamped to [0, 1] so that house numbers slightly outside the
    stated range (data quality issues) still produce a plausible point rather
    than NULL.

    Unmatched voters (no blockface candidate found) are included with NULL
    coordinates and match_type = 'none'.

    Incremental: skips external_ids already present.
    """
    table_suffix = "voters_geocoded"
    fqn = _voter_fqn(client_name, table_suffix)
    match_fqn = best_match.fqn
    voters_fqn = validated_voter_data.fqn

    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            external_id     VARCHAR,
            latitude        DOUBLE,
            longitude       DOUBLE,
            tiger_line_id   VARCHAR,
            side            VARCHAR,
            match_score     INTEGER,
            match_type      VARCHAR
        )
    """)

    conn.execute(f"""
        INSERT INTO {fqn}
        SELECT
            v.external_id,
            CASE WHEN m.geom IS NOT NULL THEN
                ST_Y(ST_LineInterpolatePoint(
                    m.geom,
                    LEAST(GREATEST(
                        (m.voter_house_number - LEAST(m.from_house_num, m.to_house_num))::DOUBLE
                        / NULLIF(
                            (GREATEST(m.from_house_num, m.to_house_num)
                             - LEAST(m.from_house_num, m.to_house_num))::DOUBLE,
                            0
                          ),
                        0.0
                    ), 1.0)
                ))
            END                 AS latitude,
            CASE WHEN m.geom IS NOT NULL THEN
                ST_X(ST_LineInterpolatePoint(
                    m.geom,
                    LEAST(GREATEST(
                        (m.voter_house_number - LEAST(m.from_house_num, m.to_house_num))::DOUBLE
                        / NULLIF(
                            (GREATEST(m.from_house_num, m.to_house_num)
                             - LEAST(m.from_house_num, m.to_house_num))::DOUBLE,
                            0
                          ),
                        0.0
                    ), 1.0)
                ))
            END                 AS longitude,
            m.tiger_line_id,
            m.side,
            m.match_score,
            CASE WHEN m.external_id IS NOT NULL THEN 'blockface' ELSE 'none' END
                                AS match_type
        FROM {voters_fqn} v
        LEFT JOIN {match_fqn} m ON v.external_id = m.external_id
        WHERE v.external_id NOT IN (SELECT external_id FROM {fqn})
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=VOTER_CATALOG,
        schema=VOTER_SCHEMA,
        table=f"{client_name}_{table_suffix}",
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 6 – summary diagnostics
# ---------------------------------------------------------------------------


def geocoding_summary(
    geocoded_voters: TableRef,
    client_name: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Compute match-rate diagnostics for the geocoded voter table.

    Writes a single-row summary table with counts and percentages broken down
    by match_type. Useful for monitoring data quality across pipeline runs.

    Always overwrites (non-incremental) since it is cheap and must reflect the
    current state of geocoded_voters.
    """
    table_suffix = "geocoding_summary"
    fqn = _voter_fqn(client_name, table_suffix)
    geocoded_fqn = geocoded_voters.fqn

    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        SELECT
            count(*)                                                        AS total_voters,
            count(*) FILTER (WHERE match_type != 'none')                   AS matched,
            count(*) FILTER (WHERE match_type  = 'none')                   AS unmatched,
            round(
                100.0 * count(*) FILTER (WHERE match_type != 'none')
                / NULLIF(count(*), 0),
                2
            )                                                               AS match_pct,
            count(*) FILTER (WHERE match_type  = 'blockface')              AS blockface_matches
        FROM {geocoded_fqn}
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=VOTER_CATALOG,
        schema=VOTER_SCHEMA,
        table=f"{client_name}_{table_suffix}",
        version=version,
    )
