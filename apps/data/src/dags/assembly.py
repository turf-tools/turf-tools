"""Assemble the canonical Person record.

Matching (`matching.py`) and position assignment (`geocode.py`)
produce intermediate per-voter outputs. This module synthesizes them
into the single canonical `persons_geocoded` record that downstream
consumers query.

    persons_best_match ─┐
    refined_positions ──┼─► canonical_addresses ─┐
    osm_only_matches ───┘                        │
                                                 ├─► persons_geocoded ─► geocoding_summary
                            persons_validated ───┘

- `canonical_addresses` produces the human-readable `address_line_1`
  per voter (see "Address handling" in AGENTS.md for source priority).
- `persons_geocoded` is a pure assembly node: joins person fields,
  canonical address, coords, and TIGER match metadata.
- `geocoding_summary` reports match-rate diagnostics broken down by
  `position_source`.
"""

import duckdb
from src.addressing import housenumber_display_sql, housenumber_norm_sql
from src.dsl.elections import (
    ELECTIONS_TABLE,
    VOTING_HISTORY_COLUMN,
    compute_election_registry,
    mask_select_exprs,
)
from src.models import TableRef
from src.tables import PERSON_CATALOG, ensure_schema, table_fqn


def _current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {PERSON_CATALOG}.current_snapshot()").fetchone()[0]


# ---------------------------------------------------------------------------
# Node 1 – canonical address strings (street name resolved via OSM or TIGER)
# ---------------------------------------------------------------------------


def canonical_addresses(
    persons_best_match: TableRef,
    persons_decomposed: TableRef,
    refined_positions: TableRef,
    osm_only_matches: TableRef,
    schema: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Per-person canonical (address_line_1, matched_tokens).

    Street-name source priority — for each voter:
      1. `refined_positions.osm_street` if non-null (the voter matched
         an OSM building). Same OSM building → same canonical → same
         building_id, so voters at the same physical building always
         share a building_id regardless of which TIGER alias they
         matched on.
      2. `osm_only_matches.osm_street` for TIGER-miss voters rescued
         via direct OSM lookup.
      3. `persons_best_match.full_name` (TIGER's canonical form for
         the matched blockface) for voters where no OSM building was
         found.

    Half-coded addresses are preserved with the "1/2" in canonical
    address_line_1.

    matched_tokens is the tokenization of the canonical street via the
    same scheme upstream tokenizers use.

    Output schema: (external_id, address_line_1, matched_tokens).

    Incremental: skips external_ids already present. Run
    `data:clear:all` to force a rebuild when this SQL changes.
    """
    table_suffix = "canonical_addresses"
    ensure_schema(conn, schema)
    fqn = table_fqn(schema, table_suffix)
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

    # Street: prefer OSM's surface form when an OSM match exists;
    # fall back to TIGER's canonical full_name otherwise.
    #
    # Housenumber: prefer OSM's surface form when the voter's parsed
    # housenumber and the OSM record's housenumber normalize to the
    # same string. This unifies surface-form variants for the same
    # physical housenumber (`646` ↔ `6-46`, `67-3` ↔ `67-03`) under
    # the form OSM uses, so they share a building_id. When the
    # normalized forms differ (e.g., voter `100` vs OSM `100A`, where
    # OSM is encoding a subunit), we keep the voter's parsed form.
    hn_display = housenumber_display_sql("house_num_prefix", "house_number", "half_code")
    conn.execute(f"""
        INSERT INTO {fqn}
        WITH src AS (
            SELECT r.external_id,
                   UPPER(COALESCE(r.osm_street, m.full_name)) AS street_canonical,
                   r.osm_housenumber
            FROM {refined_fqn} r
            LEFT JOIN {match_fqn} m ON m.external_id = r.external_id
            UNION ALL
            SELECT external_id, UPPER(osm_street) AS street_canonical, osm_housenumber
            FROM {osm_only_fqn}
        ),
        voter_hn AS (
            SELECT
                external_id,
                {hn_display} AS hn_str,
                {housenumber_norm_sql(hn_display)} AS hn_norm
            FROM {decomposed_fqn}
        )
        SELECT
            s.external_id,
            CASE
                WHEN s.osm_housenumber IS NOT NULL
                 AND {housenumber_norm_sql("s.osm_housenumber")} = vh.hn_norm
                THEN UPPER(s.osm_housenumber)
                ELSE vh.hn_str
            END
              || ' ' || s.street_canonical                    AS address_line_1,
            list_distinct(list_filter(
              list_concat(
                regexp_split_to_array(lower(trim(s.street_canonical)), '[^a-z0-9]+'),
                regexp_extract_all(lower(trim(s.street_canonical)), '[0-9]+')
              ),
              x -> length(x) > 0
            ))                                                AS matched_tokens
        FROM src s
        INNER JOIN voter_hn vh ON vh.external_id = s.external_id
        WHERE s.external_id NOT IN (SELECT external_id FROM {fqn})
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=schema,
        table=table_suffix,
        version=version,
    )


# ---------------------------------------------------------------------------
# Node 2 – assemble the canonical geocoded persons table
# ---------------------------------------------------------------------------


def persons_geocoded(
    persons_validated: TableRef,
    persons_best_match: TableRef,
    canonical_addresses: TableRef,
    refined_positions: TableRef,
    osm_only_matches: TableRef,
    schema: str,
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

    Election participation is also materialized as fixed-width mask
    columns (`voting_history_mask_<w>`, see dsl/elections.py) so the
    voting-history filters compile to bitwise tests instead of scanning
    the STRUCT[] column per query.

    Schema: drops and recreates on every run. Tolerates schema iteration
    while the canonical-record shape is being settled.
    """
    table_suffix = "persons_geocoded"
    ensure_schema(conn, schema)
    fqn = table_fqn(schema, table_suffix)
    persons_fqn = persons_validated.fqn
    match_fqn = persons_best_match.fqn
    canonical_fqn = canonical_addresses.fqn
    coords_fqn = refined_positions.fqn
    osm_only_fqn = osm_only_matches.fqn

    mask_exprs = _election_masks(conn, schema, persons_fqn)
    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        WITH normalized_persons AS (
          -- Carry every importer-produced column through generically so any
          -- manifest field reaches persons_geocoded with no pipeline edit. Only
          -- the address columns assembly rewrites are excluded and re-derived:
          -- address_line_1 (canonical), address_line_2 (normalized), half_code
          -- (consumed into the canonical address). These three are Person-core,
          -- so EXCLUDE always finds them.
          SELECT
              p.* EXCLUDE (address_line_1, address_line_2, half_code),
              TRIM(UPPER(p.address_line_2)) AS address_line_2
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
        , assembled AS (
        SELECT
            -- np.* carries all passthrough person columns (incl. any extra
            -- manifest fields). address_line_1 is the canonical rebuild; the geo
            -- columns are derived from the position/match joins. Reserved geo
            -- names (latitude, longitude, building_id, …) must not collide with
            -- an importer column — none do today.
            np.*,
            c.address_line_1,
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
        )
        -- `*_i`: lake-internal integer companions to the address-string ids —
        -- count(DISTINCT) over an 8-byte column reads a fraction of the bytes
        -- the ~25-char strings cost, and dense_rank is an exact bijection.
        -- ORDER BY zip5 clusters row groups so geography-correlated filters
        -- (zip, district) prune via zonemaps instead of scanning everything.
        SELECT
            *,
            IF(building_id IS NULL, NULL, dense_rank() OVER (ORDER BY building_id)) AS building_i,
            IF(door_id IS NULL, NULL, dense_rank() OVER (ORDER BY door_id))         AS door_i
            {"".join(f", {e}" for e in mask_exprs)}
        FROM assembled
        ORDER BY zip5
    """)

    version = _current_version(conn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=schema,
        table=table_suffix,
        version=version,
    )


def _election_masks(conn: duckdb.DuckDBPyConnection, schema: str, persons_fqn: str) -> list[str]:
    """Election-mask SELECT expressions for the persons_geocoded build, plus the
    version's `elections` registry table (bit order = year desc, type — newest
    first, so recent-election queries stay inside mask word 0). Registry counts
    run over persons_validated: a superset of the geocoded rows, so every
    above-floor election in the final table is guaranteed a bit. Datasets
    without a voting-history column get no registry and no mask columns."""
    has_column = any(
        r[0] == VOTING_HISTORY_COLUMN for r in conn.execute(f"DESCRIBE SELECT * FROM {persons_fqn} LIMIT 0").fetchall()
    )
    if not has_column:
        return []
    registry = compute_election_registry(conn, persons_fqn)
    elections_fqn = table_fqn(schema, ELECTIONS_TABLE)
    conn.execute(f"DROP TABLE IF EXISTS {elections_fqn}")
    conn.execute(f"""
        CREATE TABLE {elections_fqn} (
            key   VARCHAR,
            year  INTEGER,
            type  VARCHAR,
            bit   INTEGER
        )
    """)
    if registry:
        conn.executemany(
            f"INSERT INTO {elections_fqn} VALUES (?, ?, ?, ?)",
            [(key, year, type_, bit) for bit, (key, year, type_) in enumerate(registry)],
        )
    return mask_select_exprs([key for key, _year, _type in registry])


# ---------------------------------------------------------------------------
# Node 3 – summary diagnostics
# ---------------------------------------------------------------------------


def geocoding_summary(
    persons_geocoded: TableRef,
    persons_validated: TableRef,
    schema: str,
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
    ensure_schema(conn, schema)
    fqn = table_fqn(schema, table_suffix)
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
                  WHERE position_source IN ('osm_matched','tiger_only','osm_complex','osm_off_segment'))
                                                                                  AS matched_tiger,
                (SELECT count(*) FROM {geocoded_fqn}
                  WHERE position_source = 'osm_matched')                          AS matched_osm_road_projected,
                (SELECT count(*) FROM {geocoded_fqn}
                  WHERE position_source = 'osm_complex')                          AS matched_osm_complex,
                (SELECT count(*) FROM {geocoded_fqn}
                  WHERE position_source = 'osm_off_segment')                      AS matched_osm_off_segment,
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
            matched_osm_off_segment,
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
        schema=schema,
        table=table_suffix,
        version=version,
    )
