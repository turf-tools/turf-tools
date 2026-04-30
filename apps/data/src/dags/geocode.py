"""Hamilton graph for geocoding person addresses against TIGER blockface data.

Takes the validated persons produced by Graph 1 (`voter_file_loader`) and the
blockface reference data produced by Graph 2 (`tiger`) and produces a
geocoded persons table with lat/lon coordinates derived from linear
interpolation along the matching TIGER edge geometry.

Cross-catalog joins are performed on the single shared DuckDB connection
which has both ``ducklake`` (person data) and ``geo_ducklake`` (TIGER
blockfaces) attached.

Node dependency chain:
    validated_persons ─► decomposed_persons ─► candidate_blockfaces
                                                     │
    blockface_final ────────────────────────────────┘
                                                     │
                                              scored_matches
                                                     │
                                                best_match
                                                     │
                                             geocoded_persons
                                                     │
                                             geocoding_summary
"""

import duckdb

from src.models import TableRef

PERSON_CATALOG = "ducklake"
PERSON_SCHEMA = "main"
GEO_CATALOG = "geo_ducklake"
TIGER_SCHEMA = "tiger"


def _person_fqn(organization_slug: str, table_suffix: str) -> str:
    return f"{PERSON_CATALOG}.{PERSON_SCHEMA}.{organization_slug}_{table_suffix}"


def _current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {PERSON_CATALOG}.current_snapshot()").fetchone()[0]


# ---------------------------------------------------------------------------
# Node 1 – decompose address_line_1 into matchable parts
# ---------------------------------------------------------------------------


def decomposed_persons(
    validated_persons: TableRef,
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
    fqn = _person_fqn(organization_slug, table_suffix)
    source_fqn = validated_persons.fqn

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
        catalog=PERSON_CATALOG,
        schema=PERSON_SCHEMA,
        table=f"{organization_slug}_{table_suffix}",
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 2 – join persons to candidate blockfaces
# ---------------------------------------------------------------------------


def candidate_blockfaces(
    decomposed_persons: TableRef,
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
    5. Street-name token intersection has ≥ 2 overlapping tokens
       (filters spurious 1-token matches like "Avenue" or "Street" on
       their own; equivalence groups upstream already expand
       directionals + ordinals so most real matches comfortably clear 2).

    Multiple blockfaces may match a single person — ``scored_matches`` narrows
    these to the best one.

    Cross-catalog join: person data in ``ducklake``, blockfaces in
    ``geo_ducklake``. Both catalogs are attached on the same connection.

    Incremental: skips external_ids already present.
    """
    table_suffix = "persons_candidates"
    fqn = _person_fqn(organization_slug, table_suffix)
    persons_fqn = decomposed_persons.fqn
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
        WHERE p.external_id NOT IN (SELECT external_id FROM {fqn})
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=PERSON_SCHEMA,
        table=f"{organization_slug}_{table_suffix}",
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 3 – score each candidate match
# ---------------------------------------------------------------------------


def scored_matches(
    candidate_blockfaces: TableRef,
    decomposed_persons: TableRef,
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

    The combined ``match_score`` is used by ``best_match`` to select the single
    best blockface per person.

    Incremental: skips external_ids already present.
    """
    table_suffix = "persons_scored"
    fqn = _person_fqn(organization_slug, table_suffix)
    candidates_fqn = candidate_blockfaces.fqn
    persons_fqn = decomposed_persons.fqn

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
        schema=PERSON_SCHEMA,
        table=f"{organization_slug}_{table_suffix}",
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 4 – select best blockface per person
# ---------------------------------------------------------------------------


def best_match(
    scored_matches: TableRef,
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
    fqn = _person_fqn(organization_slug, table_suffix)
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
        schema=PERSON_SCHEMA,
        table=f"{organization_slug}_{table_suffix}",
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 5 – interpolate coordinates along blockface geometry
# ---------------------------------------------------------------------------


def geocoded_persons(
    best_match: TableRef,
    validated_persons: TableRef,
    decomposed_persons: TableRef,
    address_token_table: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Canonical geocoded persons table — the single "person record" that
    downstream consumers query against. Contains only persons who matched
    a TIGER blockface AND passed a quality filter (typically ~97% of input).

    Combines:
    - Person fields from validated_persons (pass-through; SBOE source data
      is already UPPER, no extra normalization needed for line_1/city/state/
      etc.; UPPER + TRIM applied to address_line_2 since SBOE has a small
      number of mixed-case "Num 1"-style apartment-type rows).
    - address_line_1 reconstructed from canonical components:
        decomposed.house_num_prefix + decomposed.house_number
        + ' ' + UPPER(blockface.full_name)
      The TIGER `full_name` (e.g. "E 14th St", "1st Ave") is the
      authoritative canonical street name — already in USPS-abbreviated
      ordinal form. Any source spelling that matched the same blockface
      ("EAST 14 STREET", "E 14TH ST", "1 AVE", "FIRST AVE") collapses to
      the same canonical address here. No rule maintenance in our code.
    - Lat/lon by rank-based interpolation along the matched blockface
      (voters sorted by house number within each blockface, placed at
      evenly-spaced fractions, clamped to [0.05, 0.95] to avoid
      intersection-node stacking), then offset ~7m perpendicular to the
      segment onto the correct side of the street. We don't use TIGER's
      stated address range as the interpolation denominator — Census
      documents those ranges as *potential*, not actual, and the
      mismatch ("squeeze effect") visibly compresses voters into the
      lower portion of every segment. See the `base` CTE for details.
    - Match metadata: blockface_id, person_house_number, match_score.
    - Address-derived stable keys: building_id, door_id (see
      docs/product-model.md for the keying convention).

    Persons that didn't match (no blockface candidate) are excluded from
    this table entirely. They live in validated_persons only — queryable
    from there for audit/search but cannot be canvassed (no coordinates)
    or aggregated to a building. Match-rate diagnostics in
    `geocoding_summary` reconcile counts across both tables.

    Quality filter (also drops rows): we additionally exclude matches
    where the voter clearly named a different street than what was
    matched — specifically, where the voter's "specific" tokens (those
    not in the equivalence-group stop list of directionals + street types
    + ordinal-suffix variants) have ZERO overlap with the matched street's
    specific tokens. This catches cases like voter "EAST 87 STREET" being
    matched to "E 90th St" because the actual E 87th St didn't have a
    blockface covering the voter's house number — the matcher's only
    options were wrong-street fallbacks. Rejecting is more honest than
    sending canvassers to the wrong address.

    Voters whose entire street name consists of generic tokens (e.g.
    "PARK AVENUE", "WEST DRIVE") have no specific tokens to compare; the
    rule doesn't apply and these matches are accepted. ~0.2% of matches
    in the NYC sample are filtered. See
    scripts/MATCHING_QUALITY_FINDINGS.md for the analysis.

    Schema: drops and recreates on every run. Tolerates schema iteration
    while the canonical-record shape is being settled.

    Known limitations:
    - Half-coded addresses ("111 1/2 E 14TH ST") collapse with their
      non-half neighbors ("111 E 14TH ST"). 0% in current NYC samples;
      addressable by extending decomposed_persons to surface a
      half_code column if it ever matters in real customer data.
    """
    table_suffix = "persons_geocoded"
    fqn = _person_fqn(organization_slug, table_suffix)
    match_fqn = best_match.fqn
    persons_fqn = validated_persons.fqn
    decomposed_fqn = decomposed_persons.fqn
    tokens_fqn = address_token_table.fqn

    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        WITH stop_words AS (
          -- Generic tokens: directionals (N/S/E/W), street types (St/Ave/...),
          -- ordinal variants (1st/first/...). Sourced from the same
          -- equivalence groups the matcher uses, so the rule stays in
          -- sync if the groups are extended later.
          SELECT DISTINCT lower(t) AS token
          FROM {tokens_fqn}, unnest(equivalent_tokens) AS s(t)
        ),
        ranked AS (
          -- Joined rows + dense rank by house number within each
          -- blockface. DENSE_RANK (rather than ROW_NUMBER) so two
          -- voters at the same house number share a rank — they end up
          -- at the same lat/lng instead of being scattered along the
          -- segment by an arbitrary tiebreak.
          --
          -- `blockface_id` is already side-specific upstream (TIGER
          -- edges are unpivoted into separate left/right rows in
          -- `tiger`), so partitioning on it alone keeps left and right
          -- ranks separate.
          SELECT
              p.external_id, p.external_id_type, p.first_name, p.last_name,
              p.address_line_2 AS raw_address_line_2,
              p.city, p.state, p.zip5, p.zip4, p.other_properties,
              m.geom AS bf_geom,
              m.side AS bf_side,
              m.full_name,
              m.blockface_id, m.person_house_number, m.match_score,
              d.house_num_prefix, d.house_number, d.street_name_tokens,
              DENSE_RANK() OVER (
                PARTITION BY m.blockface_id
                ORDER BY m.person_house_number
              ) AS house_rank
          FROM {persons_fqn} p
          INNER JOIN {match_fqn} m       ON m.external_id = p.external_id
          INNER JOIN {decomposed_fqn} d  ON d.external_id = p.external_id
        ),
        base AS (
          -- Rank-based interpolation fraction along the segment.
          --
          -- We do NOT use TIGER's stated `from_house_num`/`to_house_num`
          -- range. Census documents those as *potential* ranges that
          -- "include the full range of possible structure numbers even
          -- though the actual structures may not exist" — Manhattan
          -- "200-298 Broadway" really might only cover 204..252, and
          -- Queens "47-1 to 47-99" almost always only covers a sliver.
          -- Linear interpolation against the stated range systematically
          -- compresses real voters into the lower portion of the segment
          -- ("squeeze effect", Zandbergen 2008).
          --
          -- Place voters at evenly-spaced fractions ordered by house
          -- number:  frac = house_rank / (max_house_rank + 1).
          -- Voters spread the full segment in address order. One
          -- distinct house on a segment → frac = 0.5 (midpoint); N
          -- distinct houses → 1/(N+1), 2/(N+1), …, N/(N+1). Sample-
          -- density dependent: sparse fixtures cluster mid-block, full
          -- statewide data spreads naturally — fine because canvassers
          -- walk blocks in address order and don't need precise
          -- per-voter coords.
          --
          -- Clamp to [0.05, 0.95] so house N at the end of one blockface
          -- and house N+2 at the start of the next don't both snap to
          -- the shared intersection node. (PostGIS Tiger Geocoder uses
          -- the same trick.)
          SELECT
              ranked.*,
              LEAST(GREATEST(
                  house_rank::DOUBLE
                  / (1 + MAX(house_rank) OVER (PARTITION BY blockface_id)),
                  0.05
              ), 0.95) AS frac
          FROM ranked
        ),
        offset_geom AS (
          -- Compute side-of-street offset in a metric CRS so we can shift
          -- the interpolated point ~6m perpendicular to the segment.
          -- Without this every building sits on the street centerline,
          -- so opposite sides of the same street collapse onto a single
          -- line on the map.
          --
          -- Steps (NYC = UTM zone 18N = EPSG:32618):
          --   1. Project two points along the blockface (at `frac` and
          --      `frac+0.01`) to UTM so direction is in meters.
          --   2. Compute (dx, dy) and its length.
          --   3. Perpendicular vector: 'left' rotates direction CCW
          --      (-dy, dx), 'right' rotates CW (dy, -dx).
          --   4. Translate the point ±6m in that direction.
          --   5. Project back to OGC:CRS84 (lng/lat axis order, matching
          --      how blockface geometry is stored).
          --
          -- 7m chosen for NYC: NYC streets are ~12-20m wide, so this
          -- places points roughly on the curb / near the building line,
          -- giving visual separation between the two sides of a street.
          SELECT
              base.*,
              ST_Transform(ST_LineInterpolatePoint(bf_geom, frac), 'OGC:CRS84', 'EPSG:32618') AS pt_m,
              ST_X(ST_Transform(ST_LineInterpolatePoint(bf_geom, LEAST(frac + 0.01, 1.0)), 'OGC:CRS84', 'EPSG:32618'))
                - ST_X(ST_Transform(ST_LineInterpolatePoint(bf_geom, frac), 'OGC:CRS84', 'EPSG:32618')) AS dx_m,
              ST_Y(ST_Transform(ST_LineInterpolatePoint(bf_geom, LEAST(frac + 0.01, 1.0)), 'OGC:CRS84', 'EPSG:32618'))
                - ST_Y(ST_Transform(ST_LineInterpolatePoint(bf_geom, frac), 'OGC:CRS84', 'EPSG:32618')) AS dy_m
          FROM base
        ),
        final_geom AS (
          SELECT
              offset_geom.*,
              -- Final lat/lng point with side offset applied. Falls back
              -- to the un-offset point if the direction vector is
              -- zero-length (degenerate; rare but possible at exact
              -- segment endpoints).
              ST_Transform(
                CASE WHEN sqrt(dx_m * dx_m + dy_m * dy_m) > 0 THEN
                  ST_Translate(
                    pt_m,
                    -- Standard math-perpendicular: rotate the segment's
                    -- direction-of-travel vector 90° CCW for "left of
                    -- direction" → (-dy, dx). For TIGER blockfaces this
                    -- matches the `side` field semantics (verified against
                    -- AD-65 building positions).
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
        ),
        canonical AS (
          SELECT
              external_id, external_id_type, first_name, last_name,
              -- Canonical address: house number (with optional prefix
              -- like "34-" for hyphenated NYC addresses) + TIGER's
              -- authoritative street name (UPPER'd to match convention).
              -- full_name is carried through best_match from the exact
              -- blockface row the matcher chose for this person — no
              -- re-join needed, no risk of picking the wrong alias.
              COALESCE(house_num_prefix, '') || CAST(house_number AS VARCHAR)
                || ' ' || UPPER(full_name)                  AS address_line_1,
              -- SBOE has 53/10k mixed-case "Num 1" / "Num 2D"
              -- apartment-type rows in the NYC sample; UPPER fixes those.
              -- TRIM is a defensive belt against upstream whitespace.
              TRIM(UPPER(raw_address_line_2))               AS address_line_2,
              city, state, zip5, zip4, other_properties,
              ST_Y(pt_4326)                                 AS latitude,
              ST_X(pt_4326)                                 AS longitude,
              blockface_id, person_house_number, match_score,
              -- Voter's tokens (already lowercased by decomposed_persons).
              street_name_tokens AS voter_tokens,
              -- Tokenize matched full_name the same way upstream tokenizers do
              -- (split on non-alphanumeric, then extract bare digits too) so
              -- "12th St" yields ["12", "12th", "st"]. This is what we compare
              -- against voter tokens for the quality filter below.
              list_distinct(list_filter(
                list_concat(
                  regexp_split_to_array(lower(trim(full_name)), '[^a-z0-9]+'),
                  regexp_extract_all(lower(trim(full_name)), '[0-9]+')
                ),
                x -> length(x) > 0
              )) AS matched_tokens
          FROM final_geom
        )
        SELECT
            external_id, external_id_type,
            first_name, last_name,
            address_line_1, address_line_2,
            city, state, zip5, zip4,
            other_properties,
            latitude, longitude,
            blockface_id, person_house_number, match_score,
            -- Stable address-derived keys (see docs/product-model.md).
            -- Single-family doors get a double-pipe in door_id (empty
            -- middle segment) so building_id and door_id never collide.
            (address_line_1 || '|' || zip5)               AS building_id,
            (address_line_1 || '|' || COALESCE(address_line_2, '') || '|' || zip5)
                                                          AS door_id
        FROM canonical
        WHERE
          -- Quality filter: keep iff voter has no specific tokens (rule
          -- doesn't apply, e.g. "PARK AVE" is all-generic) OR voter shares
          -- at least one specific token with the matched street.
          NOT EXISTS (
            SELECT 1 FROM unnest(voter_tokens) AS v(t)
            WHERE lower(v.t) NOT IN (SELECT token FROM stop_words)
          )
          OR EXISTS (
            SELECT 1 FROM unnest(voter_tokens) AS v(t)
            WHERE lower(v.t) NOT IN (SELECT token FROM stop_words)
              AND lower(v.t) IN (
                SELECT lower(m.t)
                FROM unnest(matched_tokens) AS m(t)
                WHERE lower(m.t) NOT IN (SELECT token FROM stop_words)
              )
          )
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=PERSON_SCHEMA,
        table=f"{organization_slug}_{table_suffix}",
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 6 – summary diagnostics
# ---------------------------------------------------------------------------


def geocoding_summary(
    geocoded_persons: TableRef,
    validated_persons: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Match-rate diagnostics: total comes from validated_persons (the
    universal "all persons" table), matched comes from geocoded_persons
    (only contains successfully-matched persons since the canonical-record
    refactor). Difference = unmatched.

    Always overwrites (non-incremental) since it is cheap and must reflect the
    current state of both tables.
    """
    table_suffix = "geocoding_summary"
    fqn = _person_fqn(organization_slug, table_suffix)
    geocoded_fqn = geocoded_persons.fqn
    persons_fqn = validated_persons.fqn

    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        WITH counts AS (
            SELECT
                (SELECT count(*) FROM {persons_fqn})  AS total_persons,
                (SELECT count(*) FROM {geocoded_fqn}) AS matched
        )
        SELECT
            total_persons,
            matched,
            total_persons - matched                                         AS unmatched,
            round(100.0 * matched / NULLIF(total_persons, 0), 2)            AS match_pct,
            -- All matches are blockface-derived in the current pipeline;
            -- column is kept for backward-compatible test/RPC consumers.
            matched                                                         AS blockface_matches
        FROM counts
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=PERSON_SCHEMA,
        table=f"{organization_slug}_{table_suffix}",
        version=version,
    )
