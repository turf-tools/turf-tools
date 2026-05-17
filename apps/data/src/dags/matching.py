"""Match voter addresses to TIGER blockfaces.

Picks the single best-scoring blockface per voter. Coordinate assignment
runs downstream in `geocode.py`; canonical address derivation in
`assembly.py`. Cross-catalog joins (org-side `ducklake` to shared
`geo_ducklake`) work on the single shared DuckDB connection.

    persons_validated ─► persons_decomposed ─► persons_candidates ─► persons_scored ─► persons_best_match
                                                       ▲
    blockface_final ───────────────────────────────────┘
"""

import duckdb
from src.addressing import (
    GENERIC_STREET_TOKENS,
    street_rewrite_sql,
    tokenize_street_sql,
)
from src.models import TableRef
from src.tables import PERSON_CATALOG, ensure_org_schema, org_fqn

_GENERIC_SQL = "[" + ", ".join(f"'{t}'" for t in GENERIC_STREET_TOKENS) + "]"


def _current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {PERSON_CATALOG}.current_snapshot()").fetchone()[0]


# ---------------------------------------------------------------------------
# Node 1 – decompose address_line_1 into matchable parts
# ---------------------------------------------------------------------------


def persons_decomposed(
    persons_validated: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Parse person address strings into structured fields for blockface matching.

    ``address_line_1`` from the Person schema (e.g. "123 N Broadway") is
    split into:
    - ``house_number``      — the leading integer portion
    - ``house_num_prefix``  — any non-numeric prefix preceding the trailing
                              integer (mirrors the TIGER prefix normalisation)
    - ``street_name_raw``   — everything after the house number
    - ``street_name_tokens``— lowercase alphanumeric token array, with
                              `STREET_REWRITES` applied before tokenization
                              so the voter side converges on TIGER's form
    - ``number_type``       — "odd" / "even" derived from house_number parity

    ``zip5`` is carried through from the Person schema for the blockface ZIP
    filter.

    Incremental: skips external_ids already present.
    """
    table_suffix = "persons_decomposed"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table_suffix)
    source_fqn = persons_validated.fqn

    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            external_id         VARCHAR,
            house_number        INTEGER,
            house_num_prefix    VARCHAR,
            half_code           VARCHAR,
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
                half_code,
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
            half_code,
            street_name_raw,
            {tokenize_street_sql(street_rewrite_sql("street_name_raw"))} AS street_name_tokens,
            CASE WHEN house_number % 2 = 1 THEN 'odd' ELSE 'even' END AS number_type,
            zip5
        FROM parsed
        WHERE house_number IS NOT NULL
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table_suffix,
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 2 – join persons to candidate blockfaces
# ---------------------------------------------------------------------------


def persons_candidates(
    persons_decomposed: TableRef,
    blockface_final: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Match each decomposed person address to candidate blockfaces.

    Matching criteria (all must hold):
    1. ZIP code equality (fast partition filter)
    2. number_type parity match (odd/even)
    3. House-number prefix equality. For hyphen-prefix addresses
       (`34-12 Broadway` → prefix `34-`, house 12), the prefix
       identifies which block a voter lives on within a street. Plain
       integer addresses normalize to ``''`` so this is a no-op for
       non-hyphenated forms; without it, voters across different
       blocks of the same prefix-style street would all pile onto
       whichever blockface tiebreaks first.
    4. House number falls within the blockface address range (either direction)
    5. Street-name token intersection has ≥ 2 overlapping tokens AND
       (the voter has no distinctive tokens, OR ≥ 1 of those overlaps
       is *distinctive*, i.e. not in `GENERIC_STREET_TOKENS`). The
       distinctive check rejects wrong-street fallbacks where every
       shared token is a directional or street-type word — "East 1
       Street" and "East 11 Street" both have `[east, street]` in
       common but aren't the same street. The all-generic exception
       keeps voters at streets like "WEST DRIVE" where there's nothing
       distinctive to disambiguate against.
    6. Directional tokens compatible: opposing cardinals (N/S or E/W)
       on the two sides are rejected.

    Implementation: inverted-index join.
      - Each voter is exploded into one row per distinctive street token
        (a sentinel token for all-generic voters like "WEST DRIVE").
      - Each blockface is exploded into one row per distinctive token,
        plus a sentinel row so all-generic voters match every blockface
        in their (zip, number_type, prefix, house_range) partition.
      - The shared token is part of the equi-join key, so the hash
        join only emits pairs that already share a distinctive token
        (or the all-generic sentinel) in the same zip. DISTINCT
        collapses pairs sharing multiple distinctive tokens.
      - The full token arrays carry through (voter
        ``street_name_tokens`` vs blockface ``street_tokens_match``)
        and the ``len(list_intersect(...)) >= 2`` check is applied as
        a final filter on the much-reduced candidate set.

    Multiple blockfaces may match a single person — ``persons_scored`` narrows
    these to the best one.

    Cross-catalog join: person data in ``ducklake``, blockfaces in
    ``geo_ducklake``. Both catalogs are attached on the same connection.

    Incremental: skips external_ids already present.
    """
    table_suffix = "persons_candidates"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table_suffix)
    persons_fqn = persons_decomposed.fqn
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
            full_name           VARCHAR,
            from_node_id        VARCHAR,
            to_node_id          VARCHAR,
            geom                GEOMETRY,
            person_house_number INTEGER,
            token_overlap       INTEGER
        )
    """)

    # Sentinel value carried through the inverted index so all-generic
    # voters ("WEST DRIVE" types) get a single join key that every
    # blockface in their (zip, number_type, prefix, house_range)
    # partition will match against. Picked to be impossible as a real
    # token (no real token starts with '__').
    sentinel = "__all_generic__"

    # Pre-compute distinctive tokens + directional flags once on each
    # side as temp tables so the inverted-index unnest and the final
    # hydration both reuse them without recomputing.
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _persons_for_match AS
        SELECT
            external_id, zip5, number_type, house_num_prefix, house_number,
            street_name_tokens,
            list_filter(street_name_tokens,
                        t -> NOT list_contains({_GENERIC_SQL}, t))
                AS distinctive_tokens,
            (list_contains(street_name_tokens, 'n')
             OR list_contains(street_name_tokens, 'north'))   AS has_n,
            (list_contains(street_name_tokens, 's')
             OR list_contains(street_name_tokens, 'south'))   AS has_s,
            (list_contains(street_name_tokens, 'e')
             OR list_contains(street_name_tokens, 'east'))    AS has_e,
            (list_contains(street_name_tokens, 'w')
             OR list_contains(street_name_tokens, 'west'))    AS has_w
        FROM {persons_fqn}
        WHERE external_id NOT IN (SELECT external_id FROM {fqn})
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _blockfaces_for_match AS
        SELECT
            blockface_id, tiger_line_id, side, from_house_num, to_house_num,
            house_num_prefix, full_name, from_node_id, to_node_id, geom,
            zip_code, number_type,
            street_tokens_match,
            list_filter(street_tokens_match,
                        t -> NOT list_contains({_GENERIC_SQL}, t))
                AS distinctive_tokens,
            list_contains(street_tokens_match, 'n')          AS has_n,
            list_contains(street_tokens_match, 's')          AS has_s,
            list_contains(street_tokens_match, 'e')          AS has_e,
            list_contains(street_tokens_match, 'w')          AS has_w
        FROM {blockface_fqn}
    """)

    # Inverted index on each side: one row per distinctive token.
    # Voter side: a single sentinel row when no distinctive tokens
    # (so "WEST DRIVE" still finds candidates). Blockface side: a
    # sentinel row on EVERY blockface so it pairs with all-generic
    # voters. The sentinel rows can't join with anything other than
    # each other (no real token equals it), so distinctive voters
    # don't accidentally explode against the blockface sentinels.
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _voter_index AS
        SELECT external_id, zip5, number_type, house_num_prefix, house_number,
               t AS dtoken
        FROM _persons_for_match,
             UNNEST(CASE WHEN len(distinctive_tokens) = 0
                         THEN ['{sentinel}']
                         ELSE distinctive_tokens
                    END) AS u(t)
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _blockface_index AS
        SELECT blockface_id, zip_code, number_type, house_num_prefix,
               from_house_num, to_house_num,
               t AS dtoken
        FROM _blockfaces_for_match,
             UNNEST(list_concat(distinctive_tokens, ['{sentinel}'])) AS u(t)
    """)

    # Equi-join on (zip, dtoken, number_type, prefix) — much more
    # selective than (zip, number_type, prefix) alone. The DISTINCT
    # collapses pairs that share multiple distinctive tokens. House
    # number range still has to be a range predicate (no equi form).
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE _candidate_pairs AS
        SELECT DISTINCT v.external_id, b.blockface_id
        FROM _voter_index v
        JOIN _blockface_index b
          ON b.zip_code   = v.zip5
         AND b.dtoken     = v.dtoken
         AND b.number_type IN (v.number_type, 'mixed')
         AND COALESCE(b.house_num_prefix, '') = COALESCE(v.house_num_prefix, '')
         AND (
               v.house_number BETWEEN b.from_house_num AND b.to_house_num
            OR v.house_number BETWEEN b.to_house_num   AND b.from_house_num
         )
    """)

    # Hydrate the (voter, blockface) ID pairs back into full rows and
    # apply the remaining filters: overall token overlap ≥ 2,
    # opposing-cardinal rejection, and the house-range + prefix
    # predicate. Re-applying the range/prefix predicate is critical
    # because `_blockfaces_for_match` can have multiple rows sharing
    # the same `blockface_id` when TIGER stores multiple address
    # ranges on the same `(tlid, side)`. Without this filter a voter
    # would hydrate into every row, and downstream selection of one
    # row would be non-deterministic.
    conn.execute(f"""
        INSERT INTO {fqn}
        SELECT
            p.external_id,
            b.blockface_id,
            b.tiger_line_id,
            b.side,
            b.from_house_num,
            b.to_house_num,
            b.house_num_prefix,
            b.full_name,
            b.from_node_id,
            b.to_node_id,
            b.geom,
            p.house_number                                              AS person_house_number,
            len(list_intersect(p.street_name_tokens, b.street_tokens_match))
                                                                        AS token_overlap
        FROM _candidate_pairs c
        JOIN _persons_for_match  p ON p.external_id = c.external_id
        JOIN _blockfaces_for_match b ON b.blockface_id = c.blockface_id
        WHERE len(list_intersect(p.street_name_tokens, b.street_tokens_match)) >= 2
          AND NOT (
              (p.has_n AND b.has_s) OR (p.has_s AND b.has_n)
              OR (p.has_e AND b.has_w) OR (p.has_w AND b.has_e)
          )
          AND COALESCE(b.house_num_prefix, '') = COALESCE(p.house_num_prefix, '')
          AND (
                p.house_number BETWEEN b.from_house_num AND b.to_house_num
             OR p.house_number BETWEEN b.to_house_num   AND b.from_house_num
          )
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table_suffix,
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 3 – score each candidate match
# ---------------------------------------------------------------------------


def persons_scored(
    persons_candidates: TableRef,
    persons_decomposed: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Score each person–blockface candidate pair for match quality.

    Score components:
    - ``token_overlap``      — raw count of shared street name tokens (already
                               expanded with equivalency groups in blockface_final)
    - ``numeric_token_bonus``— extra point when the overlapping tokens include at
                               least one purely numeric token (e.g. "42" in
                               "42nd St"), reducing false matches on numbered streets

    The combined ``match_score`` is used by ``persons_best_match`` to select the single
    best blockface per person.

    Incremental: skips external_ids already present.
    """
    table_suffix = "persons_scored"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table_suffix)
    candidates_fqn = persons_candidates.fqn
    persons_fqn = persons_decomposed.fqn

    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            external_id         VARCHAR,
            blockface_id        VARCHAR,
            tiger_line_id       VARCHAR,
            side                VARCHAR,
            from_house_num      INTEGER,
            to_house_num        INTEGER,
            house_num_prefix    VARCHAR,
            full_name           VARCHAR,
            from_node_id        VARCHAR,
            to_node_id          VARCHAR,
            geom                GEOMETRY,
            person_house_number INTEGER,
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
            c.full_name,
            c.from_node_id,
            c.to_node_id,
            c.geom,
            c.person_house_number,
            c.token_overlap,
            -- Bonus when the address contains a purely numeric token (e.g. "42"
            -- in "42nd St"). This increases score for numbered-street matches,
            -- reducing false positives from short token overlaps on plain street names.
            CASE WHEN len(list_filter(
                p.street_name_tokens,
                t -> regexp_matches(t, '^[0-9]+$')
            )) > 0 THEN 1 ELSE 0 END                                    AS numeric_token_bonus,
            c.token_overlap + CASE WHEN len(list_filter(
                p.street_name_tokens,
                t -> regexp_matches(t, '^[0-9]+$')
            )) > 0 THEN 1 ELSE 0 END                                    AS match_score
        FROM {candidates_fqn} c
        JOIN {persons_fqn} p ON c.external_id = p.external_id
        WHERE c.external_id NOT IN (SELECT external_id FROM {fqn})
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table_suffix,
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 4 – select best blockface per person
# ---------------------------------------------------------------------------


def persons_best_match(
    persons_scored: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Select the single highest-scoring blockface candidate per person.

    Uses ROW_NUMBER() partitioned by external_id ordered by match_score DESC.
    Ties are broken arbitrarily (stable within a run via DuckDB's deterministic
    ordering on blockface_id).

    Incremental: skips external_ids already present.
    """
    table_suffix = "persons_best_match"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table_suffix)
    scored_fqn = persons_scored.fqn

    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            external_id         VARCHAR,
            blockface_id        VARCHAR,
            tiger_line_id       VARCHAR,
            side                VARCHAR,
            from_house_num      INTEGER,
            to_house_num        INTEGER,
            house_num_prefix    VARCHAR,
            full_name           VARCHAR,
            from_node_id        VARCHAR,
            to_node_id          VARCHAR,
            geom                GEOMETRY,
            person_house_number INTEGER,
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
            full_name,
            from_node_id,
            to_node_id,
            geom,
            person_house_number,
            match_score
        FROM (
            SELECT
                *,
                ROW_NUMBER() OVER (
                    PARTITION BY external_id
                    ORDER BY match_score DESC, blockface_id, full_name
                ) AS rn
            FROM {scored_fqn}
            WHERE external_id NOT IN (SELECT external_id FROM {fqn})
        ) ranked
        WHERE rn = 1
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table_suffix,
        version=version,
    )
