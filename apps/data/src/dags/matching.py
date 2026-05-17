"""Hamilton graph for matching voter addresses to TIGER blockfaces.

Takes the validated persons from `voter_file_loader` and the blockface
reference data from `tiger`, and produces a single best-matching blockface
per voter. Coordinate assignment happens downstream in `geocode.py`
(`refined_positions` for TIGER-matched voters, `osm_only_matches` for
TIGER-miss voters). Canonical address derivation + final assembly into
`persons_geocoded` happen in `assembly.py`.

Cross-catalog joins (person data in ``ducklake``, blockfaces in
``geo_ducklake``) run on the single shared DuckDB connection.

Node dependency chain:
    persons_validated → persons_decomposed → persons_candidates
                                                   │
    blockface_final ──────────────────────────────┘
                                                   │
                                            persons_scored
                                                   │
                                            persons_best_match
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
    3. House-number prefix equality. The prefix is the non-numeric stem
       of hyphenated Queens addresses ("34-12 Broadway" → prefix="34-").
       Both pipelines normalize plain integer addresses to ``''``, so this
       is a no-op outside Queens; without it, every "34-12 Broadway" voter
       could match every "NN-12 Broadway" blockface in the same zip and
       pile onto whichever one tiebreaks first, leaving entire blocks
       empty on the map.
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
            len(list_intersect(p.street_name_tokens, b.street_name_tokens))
                                                                        AS token_overlap
        FROM {persons_fqn} p
        JOIN {blockface_fqn} b
          ON b.zip_code   = p.zip5
         AND b.number_type IN (p.number_type, 'mixed')
         AND COALESCE(b.house_num_prefix, '') = COALESCE(p.house_num_prefix, '')
         AND (
               p.house_number BETWEEN b.from_house_num AND b.to_house_num
            OR p.house_number BETWEEN b.to_house_num   AND b.from_house_num
         )
         AND len(list_intersect(p.street_name_tokens, b.street_name_tokens)) >= 2
         AND (
              -- Voter's street name is all generic (e.g. "WEST DRIVE"):
              -- no distinctive tokens to disambiguate against, accept.
              len(list_filter(p.street_name_tokens,
                              t -> NOT list_contains({_GENERIC_SQL}, t))) = 0
              -- Otherwise require ≥ 1 distinctive overlap to reject
              -- wrong-street fallbacks like "EAST 1 ST" → "E 12 ST".
              OR len(list_filter(
                     list_intersect(p.street_name_tokens, b.street_name_tokens),
                     t -> NOT list_contains({_GENERIC_SQL}, t)
                 )) >= 1
            )
         -- Reject blockfaces whose directional contradicts the voter's.
         -- Voter tokens are raw (so we check both `n` and `north` forms);
         -- blockface tokens are equivalence-expanded so checking the
         -- short form alone is sufficient on that side. Voter without a
         -- directional or blockface without a directional always passes
         -- through; only opposing cardinal pairs are rejected.
         AND NOT (
              ((list_contains(p.street_name_tokens, 'n')
                OR list_contains(p.street_name_tokens, 'north'))
               AND list_contains(b.street_name_tokens, 's'))
           OR ((list_contains(p.street_name_tokens, 's')
                OR list_contains(p.street_name_tokens, 'south'))
               AND list_contains(b.street_name_tokens, 'n'))
           OR ((list_contains(p.street_name_tokens, 'e')
                OR list_contains(p.street_name_tokens, 'east'))
               AND list_contains(b.street_name_tokens, 'w'))
           OR ((list_contains(p.street_name_tokens, 'w')
                OR list_contains(p.street_name_tokens, 'west'))
               AND list_contains(b.street_name_tokens, 'e'))
         )
        WHERE p.external_id NOT IN (SELECT external_id FROM {fqn})
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
                    ORDER BY match_score DESC, blockface_id
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
