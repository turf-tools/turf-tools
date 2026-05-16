"""Hamilton graph for geocoding person addresses against TIGER blockface data.

Takes the validated persons produced by Graph 1 (`voter_file_loader`) and the
blockface reference data produced by Graph 2 (`tiger`) and produces a
geocoded persons table with lat/lon coordinates derived from linear
interpolation along the matching TIGER edge geometry.

Cross-catalog joins are performed on the single shared DuckDB connection
which has both ``ducklake`` (person data) and ``geo_ducklake`` (TIGER
blockfaces) attached.

Node dependency chain:
    persons_validated ─► persons_decomposed ─► persons_candidates
                                                     │
    blockface_final ────────────────────────────────┘
                                                     │
                                              persons_scored
                                                     │
                                                persons_best_match
                                                     │
                          ┌──────────────────────────┼──────────────────────────┐
                          │                          │                          │
                   refined_positions          osm_only_matches         canonical_addresses
                   (from osm.py)              (from osm.py)              (uses both above)
                          │                          │                          │
                          └──────────────────────────┴──────────────────────────┘
                                                     │
                                         persons_geocoded ◄── persons_validated
                                                     │
                                             geocoding_summary

The three peer nodes off `persons_best_match` each own one orthogonal
aspect of geocoding (coords / canonical street / quality gate) with narrow
output schemas keyed on `external_id`. `persons_geocoded` is a pure
assembly node that joins person fields, canonical address, coords, and
match metadata, restricted to the quality-gate set.
"""

import duckdb
from src.address_tokens import GENERIC_STREET_TOKENS
from src.models import TableRef
from src.tables import PERSON_CATALOG, ensure_org_schema, org_fqn

_GENERIC_SQL = "[" + ", ".join(f"'{t}'" for t in GENERIC_STREET_TOKENS) + "]"

GEO_CATALOG = "geo_ducklake"
TIGER_SCHEMA = "tiger"


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
    - ``street_name_tokens``— lowercase alphanumeric token array
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


# ---------------------------------------------------------------------------
# Node 5 – interpolated coordinates along TIGER blockface geometry
# ---------------------------------------------------------------------------


def interpolated_coords(
    persons_best_match: TableRef,
    persons_decomposed: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Per-person (latitude, longitude) by rank-based interpolation along the
    matched TIGER blockface, with a perpendicular side-of-street offset.

    Voters are sorted by (house number, half_code) within each blockface
    and placed at evenly-spaced fractions, clamped to [0.05, 0.95] to
    avoid intersection-node stacking. The point is then offset ~7m
    perpendicular to the segment onto the correct side of the street.

    The half_code in the rank key is what keeps "47" and "47 1/2" (and
    "11 A" vs "11") at adjacent-but-distinct positions instead of
    collapsing them onto the same lat/lon.

    We do NOT use TIGER's stated address range as the interpolation
    denominator — Census documents those ranges as *potential*, not actual,
    and the mismatch ("squeeze effect", Zandbergen 2008) visibly compresses
    voters into the lower portion of every segment.

    Output schema: (external_id, latitude, longitude).

    Non-incremental (drops + recreates every run): the rank/frac window
    functions partition on `blockface_id`, not `external_id`. New voters
    landing on a blockface that already has rows would shift everyone's
    fraction along the segment, so any new arrivals require a full
    recompute of all rows on the affected blockfaces. Easiest path is to
    recompute everything; the cost is bounded by `persons_best_match`
    size and the join is keyed on a single column.
    """
    table_suffix = "interpolated_coords"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table_suffix)
    match_fqn = persons_best_match.fqn
    decomposed_fqn = persons_decomposed.fqn

    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        WITH ranked AS (
          -- DENSE_RANK orders by (house_number, half_code) so two voters
          -- at the same address (modulo apartment) share a rank, while
          -- "47" and "47 1/2" get adjacent-but-distinct ranks.
          -- blockface_id is already side-specific upstream (TIGER edges
          -- are unpivoted into separate left/right rows in `tiger`), so
          -- partitioning on it alone keeps left and right ranks separate.
          SELECT
              m.external_id,
              m.blockface_id,
              m.geom AS bf_geom,
              m.side AS bf_side,
              DENSE_RANK() OVER (
                PARTITION BY m.blockface_id
                ORDER BY m.person_house_number, COALESCE(d.half_code, '')
              ) AS house_rank
          FROM {match_fqn} m
          JOIN {decomposed_fqn} d ON d.external_id = m.external_id
        ),
        base AS (
          -- frac = house_rank / (1 + max(house_rank) over blockface):
          -- one distinct house → 0.5 (midpoint); N distinct houses →
          -- 1/(N+1) … N/(N+1). Sample-density dependent: sparse fixtures
          -- cluster mid-block, full statewide data spreads naturally —
          -- fine because canvassers walk blocks in address order and
          -- don't need precise per-voter coords. Clamped so house N at
          -- the end of one blockface and house N+2 at the start of the
          -- next don't both snap to the shared intersection node.
          -- (PostGIS Tiger Geocoder uses the same trick.)
          SELECT
              external_id,
              bf_geom,
              bf_side,
              LEAST(GREATEST(
                  house_rank::DOUBLE
                  / (1 + MAX(house_rank) OVER (PARTITION BY blockface_id)),
                  0.05
              ), 0.95) AS frac
          FROM ranked
        ),
        offset_geom AS (
          -- Side-of-street offset computed in a metric CRS (NYC =
          -- UTM 18N = EPSG:32618). Without this every building sits on
          -- the street centerline and opposite sides of the same street
          -- collapse onto a single line on the map. NYC streets are
          -- ~12-20m wide, so 7m places points roughly on the curb.
          SELECT
              external_id,
              bf_side,
              ST_Transform(ST_LineInterpolatePoint(bf_geom, frac), 'OGC:CRS84', 'EPSG:32618') AS pt_m,
              ST_X(ST_Transform(ST_LineInterpolatePoint(bf_geom, LEAST(frac + 0.01, 1.0)), 'OGC:CRS84', 'EPSG:32618'))
                - ST_X(ST_Transform(ST_LineInterpolatePoint(bf_geom, frac), 'OGC:CRS84', 'EPSG:32618')) AS dx_m,
              ST_Y(ST_Transform(ST_LineInterpolatePoint(bf_geom, LEAST(frac + 0.01, 1.0)), 'OGC:CRS84', 'EPSG:32618'))
                - ST_Y(ST_Transform(ST_LineInterpolatePoint(bf_geom, frac), 'OGC:CRS84', 'EPSG:32618')) AS dy_m
          FROM base
        ),
        final_geom AS (
          -- Translate ±7m along the perpendicular: rotate the segment's
          -- direction-of-travel vector 90° CCW for "left of direction"
          -- → (-dy, dx). For TIGER blockfaces this matches the `side`
          -- field semantics (verified against AD-65 building positions).
          -- Falls back to the un-offset point if the direction vector
          -- is zero-length (degenerate; rare but possible at exact
          -- segment endpoints).
          SELECT
              external_id,
              ST_Transform(
                CASE WHEN sqrt(dx_m * dx_m + dy_m * dy_m) > 0 THEN
                  ST_Translate(
                    pt_m,
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
        SELECT
            external_id,
            ST_Y(pt_4326) AS latitude,
            ST_X(pt_4326) AS longitude
        FROM final_geom
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table_suffix,
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 6 – canonical address strings from the matched TIGER full_name
# ---------------------------------------------------------------------------


def canonical_addresses(
    persons_best_match: TableRef,
    persons_decomposed: TableRef,
    refined_positions: TableRef,
    osm_only_matches: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Per-person canonical (address_line_1, matched_tokens).

    Street-name source priority — for each voter:
      1. `refined_positions.osm_street` if non-null (the voter matched
         an OSM building, regardless of whether they also matched
         TIGER). Same OSM building → same canonical → same building_id.
         This prevents the dupe pattern where TIGER-matched voters and
         osm_only voters at the same physical building end up with
         different canonical street names ("F D R Dr" vs "FDR Drive").
      2. `osm_only_matches.osm_street` for TIGER-miss voters rescued
         via direct OSM lookup.
      3. `persons_best_match.full_name` (TIGER's authoritative form)
         for tiger_only voters where no OSM building was found.

    Half-coded addresses are preserved with the "1/2" in canonical
    address_line_1.

    matched_tokens is the tokenization of the canonical street via the
    same scheme upstream tokenizers use.

    Output schema: (external_id, address_line_1, matched_tokens).

    Incremental: skips external_ids already present.
    """
    table_suffix = "canonical_addresses"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table_suffix)
    match_fqn = persons_best_match.fqn
    decomposed_fqn = persons_decomposed.fqn
    refined_fqn = refined_positions.fqn
    osm_only_fqn = osm_only_matches.fqn

    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            external_id     VARCHAR,
            address_line_1  VARCHAR,
            matched_tokens  VARCHAR[]
        )
    """)

    # For TIGER-matched voters, prefer OSM street when the OSM lookup
    # hit (osm_street IS NOT NULL); fall back to TIGER full_name. For
    # osm_only voters, always use OSM street.
    conn.execute(f"""
        INSERT INTO {fqn}
        WITH src AS (
            SELECT r.external_id,
                   UPPER(COALESCE(r.osm_street, m.full_name)) AS street_canonical
            FROM {refined_fqn} r
            LEFT JOIN {match_fqn} m ON m.external_id = r.external_id
            UNION ALL
            SELECT external_id, UPPER(osm_street) AS street_canonical
            FROM {osm_only_fqn}
        )
        SELECT
            s.external_id,
            COALESCE(d.house_num_prefix, '') || CAST(d.house_number AS VARCHAR)
              || CASE WHEN d.half_code IS NOT NULL AND d.half_code != ''
                      THEN ' ' || d.half_code
                      ELSE '' END
              || ' ' || s.street_canonical                    AS address_line_1,
            list_distinct(list_filter(
              list_concat(
                regexp_split_to_array(lower(trim(s.street_canonical)), '[^a-z0-9]+'),
                regexp_extract_all(lower(trim(s.street_canonical)), '[0-9]+')
              ),
              x -> length(x) > 0
            ))                                                AS matched_tokens
        FROM src s
        INNER JOIN {decomposed_fqn} d ON d.external_id = s.external_id
        WHERE s.external_id NOT IN (SELECT external_id FROM {fqn})
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table_suffix,
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 8 – assemble the canonical geocoded persons table
# ---------------------------------------------------------------------------


def persons_geocoded(
    persons_validated: TableRef,
    persons_best_match: TableRef,
    canonical_addresses: TableRef,
    refined_positions: TableRef,
    osm_only_matches: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Canonical geocoded persons table — the single "person record" that
    downstream consumers query against. Contains every voter that ended
    up with coordinates, whether via TIGER blockface match or via
    direct OSM lookup (`osm_only_matches`).

    Pure assembly node: joins person fields from `persons_validated`,
    canonical address from `canonical_addresses`, lat/lon from
    `refined_positions` OR `osm_only_matches` (coalesced), TIGER
    metadata from `persons_best_match` (LEFT JOIN — osm-only voters
    legitimately have no row), and a `blockface_id` that's either the
    TIGER blockface or the nearest-blockface snap from
    `osm_only_matches`. `position_source` is `'osm_only'` for the
    osm-only voters.

    address_line_2 normalization (UPPER + TRIM) happens here because it
    comes straight from `persons_validated` with no TIGER/OSM-derived
    equivalent — SBOE has a small number of mixed-case "Num 1"-style
    apartment-type rows. SBOE source data is otherwise already UPPER, so
    line_1/city/state/etc. pass through.

    Persons that didn't end up in either `refined_positions` or
    `osm_only_matches` are excluded entirely — they live in
    `persons_validated` only. Match-rate diagnostics in
    `geocoding_summary` reconcile counts across both tables.

    Address-derived stable keys (`building_id`, `door_id`) are computed
    here once both `address_line_1` (canonical) and `address_line_2`
    (validated) are in scope. See docs/product-model.md for the keying
    convention. Single-family doors get a double-pipe in door_id (empty
    middle segment) so building_id and door_id never collide.

    Schema: drops and recreates on every run. Tolerates schema iteration
    while the canonical-record shape is being settled.
    """
    table_suffix = "persons_geocoded"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table_suffix)
    persons_fqn = persons_validated.fqn
    match_fqn = persons_best_match.fqn
    canonical_fqn = canonical_addresses.fqn
    coords_fqn = refined_positions.fqn
    osm_only_fqn = osm_only_matches.fqn

    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        WITH normalized_persons AS (
          SELECT
              p.external_id,
              p.external_id_type,
              p.first_name,
              p.last_name,
              TRIM(UPPER(p.address_line_2)) AS address_line_2,
              p.city,
              p.state,
              p.zip5,
              p.zip4,
              p.other_properties
          FROM {persons_fqn} p
        ),
        -- Coordinates come from refined_positions for TIGER-matched
        -- voters, osm_only_matches for the rule-3 rescues. Each voter
        -- appears in exactly one (refined_positions excludes voters
        -- without a TIGER blockface; osm_only_matches excludes those
        -- with one).
        positions AS (
          SELECT external_id, latitude, longitude, position_source,
                 NULL::VARCHAR AS osm_blockface_id
          FROM {coords_fqn}
          UNION ALL
          SELECT external_id, latitude, longitude,
                 'osm_only' AS position_source,
                 blockface_id AS osm_blockface_id
          FROM {osm_only_fqn}
        )
        SELECT
            np.external_id,
            np.external_id_type,
            np.first_name,
            np.last_name,
            c.address_line_1,
            np.address_line_2,
            np.city,
            np.state,
            np.zip5,
            np.zip4,
            np.other_properties,
            p.latitude,
            p.longitude,
            p.position_source,
            COALESCE(m.blockface_id, p.osm_blockface_id)                    AS blockface_id,
            m.person_house_number,
            m.match_score,
            (c.address_line_1 || '|' || np.zip5)                            AS building_id,
            (c.address_line_1 || '|' || COALESCE(np.address_line_2, '') || '|' || np.zip5)
                                                                            AS door_id
        FROM normalized_persons np
        INNER JOIN {canonical_fqn} c ON c.external_id = np.external_id
        INNER JOIN positions p       ON p.external_id = np.external_id
        LEFT  JOIN {match_fqn} m     ON m.external_id = np.external_id
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table_suffix,
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 9 – summary diagnostics
# ---------------------------------------------------------------------------


def geocoding_summary(
    persons_geocoded: TableRef,
    persons_validated: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Match-rate diagnostics: total comes from persons_validated (the
    universal "all persons" table), matched comes from persons_geocoded
    (only contains successfully-matched persons). Difference = unmatched.

    Broken down by `position_source` so the TIGER pipeline vs OSM-only
    rescue contributions are visible at a glance.

    Always overwrites (non-incremental) since it is cheap and must reflect
    the current state of both tables.
    """
    table_suffix = "geocoding_summary"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table_suffix)
    geocoded_fqn = persons_geocoded.fqn
    persons_fqn = persons_validated.fqn

    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        WITH counts AS (
            SELECT
                (SELECT count(*) FROM {persons_fqn})                              AS total_persons,
                (SELECT count(*) FROM {geocoded_fqn})                             AS matched,
                (SELECT count(*) FROM {geocoded_fqn}
                  WHERE position_source IN ('osm_matched','tiger_only','osm_complex'))
                                                                                  AS matched_tiger,
                (SELECT count(*) FROM {geocoded_fqn}
                  WHERE position_source = 'osm_matched')                          AS matched_osm_road_projected,
                (SELECT count(*) FROM {geocoded_fqn}
                  WHERE position_source = 'osm_complex')                          AS matched_osm_complex,
                (SELECT count(*) FROM {geocoded_fqn}
                  WHERE position_source = 'tiger_only')                           AS matched_tiger_only,
                (SELECT count(*) FROM {geocoded_fqn}
                  WHERE position_source = 'osm_only')                             AS matched_osm_only
        )
        SELECT
            total_persons,
            matched,
            total_persons - matched                                         AS unmatched,
            round(100.0 * matched / NULLIF(total_persons, 0), 2)            AS match_pct,
            matched_tiger,
            matched_osm_road_projected,
            matched_osm_complex,
            matched_tiger_only,
            matched_osm_only,
            -- Backward-compat alias for older test/RPC consumers; counts every
            -- voter that has any position (including osm_only).
            matched                                                         AS blockface_matches
        FROM counts
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table_suffix,
        version=version,
    )
