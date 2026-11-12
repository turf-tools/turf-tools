"""Assemble the canonical Person record.

Matching (`matching.py`) and position assignment (`geocode.py`)
produce intermediate per-voter outputs. This module synthesizes them
into the single canonical `persons_geocoded` record that downstream
consumers query.

    persons_best_match ─┐
    refined_positions ──┤
    osm_only_matches ───┼─► canonical_addresses ─┐
    address_tokens ─────┘                        │
                                                 ├─► persons_geocoded ─► geocoding_summary
                            persons_validated ───┘

- `canonical_addresses` produces the human-readable `address_line_1`
  and the building's ZIP per voter (see "Address handling" in
  AGENTS.md).
- `persons_geocoded` is a pure assembly node: joins person fields,
  canonical address, coords, and TIGER match metadata.
- `geocoding_summary` reports match-rate diagnostics broken down by
  `position_source`.
"""

import time

import duckdb
from src.addressing import (
    canonical_key_sql,
    housenumber_display_sql,
    housenumber_norm_sql,
    street_rewrite_sql,
    tokenize_street_sql,
)
from src.dsl.criteria import person_h_sql
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
# Node 1 – canonical address strings and building ZIPs
# ---------------------------------------------------------------------------


def canonical_addresses(
    persons_best_match: TableRef,
    persons_decomposed: TableRef,
    refined_positions: TableRef,
    osm_only_matches: TableRef,
    address_tokens: TableRef,
    schema: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Per-person canonical (address_line_1, matched_tokens, building_zip5).

    A building is the OSM record a voter matched (`osm_kind`, `osm_id`), else
    the voter's TIGER blockface side and address. Each building gets one
    address and one ZIP, so everyone in it shares a building_id.

    Street: TIGER's spelling. Voters with no OSM match show their matched
    blockface's `full_name`. An OSM building shows how TIGER-matched voters
    in the building's ZIP spell its street (the TIGER name with the OSM
    street's key, `osm_key`, see `src/addressing.py`; most common, then
    alphabetical), or OSM's street when TIGER doesn't name it in that ZIP.

    Housenumber: OSM's surface form when it normalizes to the voter's
    parsed form, so variants of one number (`646` ↔ `6-46`, `67-3` ↔
    `67-03`) share a building_id; else the voter's form (voter `100` vs OSM
    `100A`, where OSM encodes a subunit). Half-codes keep their "1/2".

    building_zip5: the most common voter ZIP in the building, lowest on
    ties. Voters at one building sometimes write different ZIPs; each keeps
    their own `zip5`, and the building's ids use this one.

    matched_tokens is the tokenization of the canonical street via the
    same scheme upstream tokenizers use.

    Incremental: skips external_ids already present. Run
    `data:clear:all` to force a rebuild when this SQL changes.
    """
    table_suffix = "canonical_addresses"
    ensure_schema(conn, schema)
    fqn = table_fqn(schema, table_suffix)

    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {fqn} (
            external_id     VARCHAR,
            address_line_1  VARCHAR,
            matched_tokens  VARCHAR[],
            building_zip5   VARCHAR
        )
    """)

    print("Settling canonical addresses…")
    t0 = time.time()
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _ca_src AS
        SELECT r.external_id, m.full_name AS tiger_name, m.blockface_id,
               r.osm_street, r.osm_housenumber, r.osm_kind, r.osm_id, r.osm_key
        FROM {refined_positions.fqn} r
        LEFT JOIN {persons_best_match.fqn} m ON m.external_id = r.external_id
        UNION ALL
        SELECT external_id, NULL, NULL,
               osm_street, osm_housenumber, osm_kind, osm_id, osm_key
        FROM {osm_only_matches.fqn}
    """)
    # TIGER names keyed the way the OSM side is (`osm.osm_addresses_keyed`),
    # once per distinct name.
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _ca_tiger_keys AS
        WITH tokens AS (
            SELECT name, {tokenize_street_sql(street_rewrite_sql("name"))} AS raw_tokens
            FROM (SELECT DISTINCT tiger_name AS name FROM _ca_src WHERE tiger_name IS NOT NULL)
        ),
        extras AS (
            SELECT n.name, flatten(list(t.equivalent_tokens)) AS extra
            FROM tokens n
            JOIN {address_tokens.fqn} t ON len(list_intersect(n.raw_tokens, t.equivalent_tokens)) > 0
            GROUP BY n.name
        )
        SELECT n.name,
               {canonical_key_sql("list_distinct(list_concat(n.raw_tokens, COALESCE(e.extra, [])))")}
                   AS tiger_key
        FROM tokens n LEFT JOIN extras e USING (name)
    """)
    hn_display = housenumber_display_sql("d.house_num_prefix", "d.house_number", "d.half_code")
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _ca_voters AS
        SELECT s.*, k.tiger_key, d.zip5,
               {hn_display} AS hn_str,
               {housenumber_norm_sql(hn_display)} AS hn_norm
        FROM _ca_src s
        JOIN {persons_decomposed.fqn} d ON d.external_id = s.external_id
        LEFT JOIN _ca_tiger_keys k ON k.name = s.tiger_name
    """)
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE _ca_zip_spelling AS
        SELECT zip5, tiger_key, spelling
        FROM (
            SELECT zip5, tiger_key, UPPER(tiger_name) AS spelling,
                   ROW_NUMBER() OVER (
                       PARTITION BY zip5, tiger_key
                       ORDER BY count(*) DESC, UPPER(tiger_name)
                   ) AS rn
            FROM _ca_voters
            WHERE tiger_name IS NOT NULL
            GROUP BY zip5, tiger_key, UPPER(tiger_name)
        )
        WHERE rn = 1
    """)
    conn.execute(f"""
        INSERT INTO {fqn}
        WITH keyed AS (
            SELECT *,
                CASE WHEN osm_id IS NOT NULL THEN concat_ws('|', 'osm', osm_kind, osm_id)
                     ELSE concat_ws('|', 'tiger', blockface_id, hn_str, UPPER(tiger_name))
                END AS building_key
            FROM _ca_voters
        ),
        zipped AS (
            SELECT *,
                first_value(zip5) OVER (
                    PARTITION BY building_key ORDER BY zip_n DESC, zip5
                ) AS building_zip5
            FROM (SELECT *, count(*) OVER (PARTITION BY building_key, zip5) AS zip_n FROM keyed)
        ),
        -- The spelling is looked up by the building's ZIP, not each voter's,
        -- so one building gets one spelling.
        addressed AS (
            SELECT k.external_id, k.building_zip5,
                CASE WHEN k.osm_id IS NULL THEN UPPER(k.tiger_name)
                     ELSE COALESCE(z.spelling, UPPER(k.osm_street))
                END AS street,
                CASE
                    WHEN k.osm_housenumber IS NOT NULL
                     AND {housenumber_norm_sql("k.osm_housenumber")} = k.hn_norm
                    THEN UPPER(k.osm_housenumber)
                    ELSE k.hn_str
                END AS hn
            FROM zipped k
            LEFT JOIN _ca_zip_spelling z ON z.zip5 = k.building_zip5 AND z.tiger_key = k.osm_key
        )
        SELECT
            external_id,
            hn || ' ' || street                               AS address_line_1,
            list_distinct(list_filter(
              list_concat(
                regexp_split_to_array(lower(trim(street)), '[^a-z0-9]+'),
                regexp_extract_all(lower(trim(street)), '[0-9]+')
              ),
              x -> length(x) > 0
            ))                                                AS matched_tokens,
            building_zip5
        FROM addressed
        WHERE external_id NOT IN (SELECT external_id FROM {fqn})
    """)
    n = conn.execute(f"SELECT count(*) FROM {fqn}").fetchone()[0]
    print(f"  {n:,} canonical addresses in {time.time() - t0:.1f}s")

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
    (validated) are in scope, keyed on the building's ZIP
    (`building_zip5`) rather than each voter's own. See
    docs/product-model.md for the keying convention. Single-family doors
    get a double-pipe in door_id (empty middle segment) so building_id and
    door_id never collide.

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
          -- manifest field reaches persons_geocoded with no pipeline edit.
          -- Excluded: the address columns assembly rewrites and re-derives —
          -- address_line_1 (canonical), address_line_2 (normalized), half_code
          -- (consumed into the canonical address) — and county_fips, which only
          -- the import's geo extent reads. All are Person-core, so EXCLUDE
          -- always finds them.
          SELECT
              p.* EXCLUDE (address_line_1, address_line_2, half_code, county_fips),
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
            c.building_zip5,
            (c.address_line_1 || '|' || c.building_zip5)                    AS building_id,
            (c.address_line_1 || '|' || COALESCE(np.address_line_2, '') || '|' || c.building_zip5)
                                                                            AS door_id
        FROM normalized_persons np
        INNER JOIN {canonical_fqn} c ON c.external_id = np.external_id
        INNER JOIN positions p       ON p.external_id = np.external_id
        LEFT  JOIN {match_fqn} m     ON m.external_id = np.external_id
        )
        -- `*_i`: lake-internal integer companions to the address-string ids —
        -- count(DISTINCT) over an 8-byte column reads a fraction of the bytes
        -- the ~25-char strings cost, and dense_rank is an exact bijection.
        -- `person_h`: integer companion to external_id for cross-table joins
        -- (custom-field filters semi-join on it). A value hash, not a rank:
        -- the custom-fields tables float across versions, so the key must be
        -- a pure function of the id — MD5 so it's also stable across engine
        -- versions. Collision-checked below.
        -- ORDER BY zip5 clusters row groups so geography-correlated filters
        -- (zip, district) prune via zonemaps instead of scanning everything.
        SELECT
            *,
            IF(building_id IS NULL, NULL, dense_rank() OVER (ORDER BY building_id)) AS building_i,
            IF(door_id IS NULL, NULL, dense_rank() OVER (ORDER BY door_id))         AS door_i,
            {person_h_sql()}                                                        AS person_h
            {"".join(f", {e}" for e in mask_exprs)}
        FROM assembled
        ORDER BY zip5
    """)
    distinct_ids, distinct_hashes = conn.execute(
        f"SELECT count(DISTINCT external_id), count(DISTINCT person_h) FROM {fqn}"
    ).fetchone()
    if distinct_ids != distinct_hashes:
        raise RuntimeError(f"person_h collision in {fqn}: {distinct_ids} ids, {distinct_hashes} hashes")

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
