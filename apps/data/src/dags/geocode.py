"""Hamilton graph for assigning lat/lon coordinates to voters.

The actual geocoding step: takes voters from `matching.py`
(`persons_best_match`) and OSM building data from `osm.py`
(`osm_building_lookup`), and produces a per-voter lat/lon.

Two paths in this module:

  1. `refined_positions` — for TIGER-matched voters: project the OSM
     building centroid onto the matched TIGER blockface (or use the
     OSM centroid directly when the building is inside a
     `landuse=residential` polygon).

  2. `osm_only_matches` — for voters TIGER couldn't match: derive a
     canonical_key from the voter's raw address, look them up in OSM
     directly, and snap to the nearest blockface in their zip for
     downstream grouping.

Each voter ends up in exactly one of these two outputs. `assembly.py`
unions them when building `persons_geocoded`.

`position_source` values:
  - `osm_matched`  — TIGER + OSM, road-projected
  - `osm_complex`  — TIGER + OSM, inside landuse=residential (no projection)
  - `tiger_only`   — TIGER but no OSM, rank-based fallback
  - `osm_only`     — TIGER-miss, rescued via direct OSM lookup
"""

import time

import duckdb
from src.addressing import (
    canonical_key_sql,
    street_rewrite_sql,
    tokenize_street_sql,
)
from src.models import TableRef
from src.tables import PERSON_CATALOG, ensure_org_schema, org_fqn


def _current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {PERSON_CATALOG}.current_snapshot()").fetchone()[0]


# ---------------------------------------------------------------------------
# Node 1 – per-voter refined position (TIGER + OSM)
# ---------------------------------------------------------------------------


def refined_positions(
    persons_best_match: TableRef,
    persons_decomposed: TableRef,
    blockface_final: TableRef,
    osm_building_lookup: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Per-voter (latitude, longitude, position_source, osm_street).

    Position rule:
      1. Match the voter to an OSM address by exact
         `(zip5, canonical_key, housenumber)`. Pick the way variant
         over a node variant when both exist (way = building polygon
         centroid; node = doorway).
      2. If matched AND the building centroid is inside an OSM
         `landuse=residential` polygon (Co-op City, Stuy Town, …),
         use the OSM centroid directly — no road projection, no
         perpendicular offset.
      3. Else if matched AND the OSM centroid projects strictly onto
         the matched TIGER blockface (`osm_frac ∈ (0, 1)`):
         `fraction = ST_LineLocatePoint(blockface, OSM)` projects the
         OSM-known building centroid onto the TIGER blockface for an
         along-road position.
      4. Else if matched but the projection *clamps*
         (`osm_frac = 0.0 or 1.0` — the OSM building is geometrically
         beyond the blockface's endpoints, typically because TIGER's
         address range exceeds its physical geometry): use the OSM
         centroid directly. This avoids snapping voters to the wrong
         end of a too-short blockface.
      5. Else (no OSM match): `fraction = rank / (max_rank + 1)` via
         DENSE_RANK ordering by (prefix, housenumber, half_code) —
         the original TIGER linear-ramp behavior.
      6. Road-projected positions (cases 3 and 5) get a 7 m
         perpendicular offset and a 1D shove so distinct buildings
         stay ≥ 4 m apart.

    `position_source` is one of:
      - `osm_complex`     — OSM centroid, inside a residential complex
      - `osm_matched`     — fraction from OSM projection onto the blockface
      - `osm_off_segment` — OSM centroid (projection clamped on matched blockface)
      - `tiger_only`      — fraction from DENSE_RANK fallback

    `osm_street` is carried through so `canonical_addresses` can pick
    OSM's per-building canonical name (more stable than TIGER's, which
    has aliases for the same physical street).

    Non-incremental: drops + recreates every run. DENSE_RANK is a
    window over the full blockface, so new voters would shift everyone
    else's rank.
    """
    table_suffix = "refined_positions"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table_suffix)

    pbm = persons_best_match.fqn
    pd_ = persons_decomposed.fqn
    bf_ = blockface_final.fqn
    obl = osm_building_lookup.fqn

    conn.execute(f"DROP TABLE IF EXISTS {fqn}")

    print("Refining voter positions…")
    t0 = time.time()
    # Use `canonical_tokens` for the OSM canonical_key — those are the
    # tokens of the canonical (frequency-winner) full_name only, not
    # the alias-merged set. With this, voters using either alias
    # ("1827 7TH AVE" / "1827 ACP BLVD") produce the same canonical_key
    # and deterministically hit the same OSM record.
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _bf_for_voters AS
        SELECT DISTINCT ON (blockface_id) blockface_id, canonical_tokens
        FROM {bf_}
        WHERE geom IS NOT NULL
        -- Deterministic pick when blockface_id appears on multiple rows
        -- (Queens prefix variants etc). All such rows share canonical_tokens
        -- after the alias collapse, so the chosen row doesn't change semantics,
        -- but an explicit ORDER BY keeps the pick stable across runs.
        ORDER BY blockface_id, from_house_num, to_house_num
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _voter_keyed AS
        SELECT
            m.external_id, m.blockface_id, m.geom AS bf_geom, m.side AS bf_side,
            m.tiger_line_id,
            m.person_house_number,
            COALESCE(d.half_code, '') AS half_code,
            COALESCE(d.house_num_prefix, '') AS house_num_prefix,
            d.zip5,
            {canonical_key_sql("b.canonical_tokens")} AS canonical_key,
            COALESCE(d.house_num_prefix, '')
              || CAST(d.house_number AS VARCHAR)
              || CASE WHEN d.half_code IS NOT NULL AND d.half_code != ''
                      THEN ' ' || d.half_code ELSE '' END AS housenumber_str,
            regexp_replace(
                regexp_replace(
                    COALESCE(d.house_num_prefix, '')
                      || CAST(d.house_number AS VARCHAR)
                      || CASE WHEN d.half_code IS NOT NULL AND d.half_code != ''
                              THEN ' ' || d.half_code ELSE '' END,
                    '(^|-)0*([0-9])', '\\1\\2', 'g'),
                '-', '', 'g'
            ) AS housenumber_norm
        FROM {pbm} m
        JOIN {pd_} d        ON d.external_id  = m.external_id
        JOIN _bf_for_voters b ON b.blockface_id = m.blockface_id
    """)

    # Hash join on (zip, canonical_key, housenumber_norm) — strict equality.
    # When the voter has a half_code, the joined OSM housenumber must also
    # carry that suffix; OSM rarely tags half-codes, so half-coded voters
    # mostly fall back to the DENSE_RANK ramp (which orders by half_code,
    # so 47 and 47-1/2 still get distinct positions).
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _voter_with_osm AS
        SELECT v.*, o.osm_lat, o.osm_lon,
               o.street AS osm_street,
               o.housenumber AS osm_housenumber,
               COALESCE(o.in_residential_complex, false) AS in_complex
        FROM _voter_keyed v
        LEFT JOIN {obl} o
          ON o.zip_code         = v.zip5
         AND o.canonical_key    = v.canonical_key
         AND o.housenumber_norm = v.housenumber_norm
    """)
    n_matched = conn.execute("""
        SELECT count(*) FROM _voter_with_osm WHERE osm_lat IS NOT NULL
    """).fetchone()[0]
    n_total = conn.execute("SELECT count(*) FROM _voter_with_osm").fetchone()[0]
    print(f"  {n_matched:,}/{n_total:,} voters got an OSM match "
          f"({100.0 * n_matched / max(n_total, 1):.1f}%) in {time.time()-t0:.1f}s")

    print("  computing fractions + final positions…")
    t0 = time.time()
    # All math in UTM-18N. ST_LineLocatePoint in geographic degrees gives
    # a non-perpendicular foot on non-cardinal streets — the rotated
    # grid skews along-street by up to ~20% of the perpendicular offset.
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        -- Pre-compute the UTM-transformed geometry and OSM projection
        -- fraction once per voter. Doing this up-front lets us route
        -- clamping-OSM voters to the OSM-centroid branch before they
        -- enter the projection/shove pipeline.
        WITH voter_geo AS (
            SELECT
                external_id, blockface_id, bf_side, tiger_line_id,
                house_num_prefix, person_house_number, half_code,
                osm_lat, osm_lon, osm_street, osm_housenumber, in_complex,
                ST_Transform(bf_geom, 'OGC:CRS84', 'EPSG:32618') AS bf_m,
                CASE WHEN osm_lat IS NOT NULL
                     THEN ST_Transform(ST_Point(osm_lon, osm_lat),
                                       'OGC:CRS84', 'EPSG:32618')
                     ELSE NULL
                END AS osm_pt_m
            FROM _voter_with_osm
        ),
        with_osm_frac AS (
            SELECT *,
                CASE WHEN osm_pt_m IS NOT NULL
                     THEN ST_LineLocatePoint(bf_m, osm_pt_m)
                     ELSE NULL
                END AS osm_frac
            FROM voter_geo
        ),
        -- Voters going through the projection/shove path: NOT
        -- in_complex AND NOT off-segment-clamped. The clamped-with-OSM
        -- voters are routed to the OSM-centroid branch in the final
        -- UNION below — projecting them onto a blockface whose
        -- geometry doesn't span their OSM building would land them at
        -- a wrong endpoint of a too-short TIGER segment.
        ranked AS (
            -- Partition by (tiger_line_id, bf_side) so voters across
            -- multiple address ranges on the same physical TIGER line
            -- (Queens 219-XX / 220-XX / 221-XX on the same block of
            -- 121st Ave, where TIGER stores them as separate addrfeat
            -- rows sharing one geometry) share a ranking partition.
            -- Ordering by (prefix, house_number, half_code) gives each
            -- prefix-block its own contiguous chunk of the line —
            -- 219-* voters in the first slice, 220-* next, etc. —
            -- instead of all voters at the same house_number collapsing
            -- onto a single rank.
            --
            -- For the non-Queens case (single prefix per tlid:side),
            -- this partition is identical to PARTITION BY blockface_id,
            -- so no behavior change.
            SELECT *,
                DENSE_RANK() OVER (
                    PARTITION BY tiger_line_id, bf_side
                    ORDER BY house_num_prefix, person_house_number, half_code
                ) AS house_rank
            FROM with_osm_frac
            WHERE NOT in_complex
              AND NOT (osm_lat IS NOT NULL
                       AND (osm_frac = 0.0 OR osm_frac = 1.0))
        ),
        fracced AS (
            SELECT *,
                MAX(house_rank) OVER (PARTITION BY tiger_line_id, bf_side) AS max_rank
            FROM ranked
        ),
        with_frac AS (
            SELECT external_id, blockface_id, bf_side, tiger_line_id, bf_m,
                house_rank,
                CASE WHEN osm_frac > 0.0 AND osm_frac < 1.0
                     THEN 'osm_matched' ELSE 'tiger_only'
                END AS position_source,
                LEAST(GREATEST(
                    CASE WHEN osm_frac > 0.0 AND osm_frac < 1.0
                         THEN osm_frac
                         ELSE house_rank::DOUBLE / (1 + max_rank)
                    END,
                    0.05
                ), 0.95) AS frac
            FROM fracced
        ),
        shoved AS (
            -- 1D shove in building space: keep distinct buildings at
            -- least 4 m apart along the line. DENSE_RANK groups voters
            -- that share a (frac, house_rank) into one slot so apartment
            -- buildings stay anchored. The house_rank tiebreak prevents
            -- two distinct buildings (different housenumbers) whose OSM
            -- projections coincide at the same frac from collapsing
            -- onto a single point.
            -- sep_frac shrinks when there are more buildings than fit
            -- at 4 m so overflow doesn't pile at the 0.95 cap (Co-op
            -- City: 16 numbered towers on a 21.7 m blockface).
            -- The backward cap (0.95 - (n_buildings - rn) * sep_frac)
            -- prevents buildings clustered near the end of a blockface
            -- from all piling at 0.95 when the forward pass overshoots.
            SELECT external_id, bf_side, bf_m, position_source,
                LEAST(GREATEST(
                    LEAST(
                        MAX(frac - rn * sep_frac)
                            OVER (PARTITION BY tiger_line_id, bf_side
                                  ORDER BY rn)
                          + rn * sep_frac,
                        0.95 - (n_buildings - rn) * sep_frac
                    ),
                    0.05
                ), 0.95) AS frac
            FROM (
                SELECT *,
                    LEAST(4.0, 0.9 * bf_len_m / GREATEST(n_buildings, 1))
                      / NULLIF(bf_len_m, 0) AS sep_frac
                FROM (
                    SELECT *,
                        MAX(rn) OVER (PARTITION BY tiger_line_id, bf_side)
                            AS n_buildings
                    FROM (
                        SELECT *,
                            DENSE_RANK() OVER (PARTITION BY tiger_line_id,
                                                            bf_side
                                               ORDER BY frac, house_rank) AS rn,
                            ST_Length(bf_m) AS bf_len_m
                        FROM with_frac
                    )
                )
            )
        ),
        offset_geom AS (
            SELECT external_id, bf_side, position_source,
                ST_LineInterpolatePoint(bf_m, frac) AS pt_m,
                ST_X(ST_LineInterpolatePoint(bf_m, LEAST(frac + 0.01, 1.0)))
                  - ST_X(ST_LineInterpolatePoint(bf_m, frac)) AS dx_m,
                ST_Y(ST_LineInterpolatePoint(bf_m, LEAST(frac + 0.01, 1.0)))
                  - ST_Y(ST_LineInterpolatePoint(bf_m, frac)) AS dy_m
            FROM shoved
        ),
        final_geom AS (
            SELECT external_id, position_source,
                ST_Transform(
                  CASE WHEN sqrt(dx_m * dx_m + dy_m * dy_m) > 0 THEN
                    ST_Translate(pt_m,
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
        SELECT f.external_id,
               ST_Y(f.pt_4326) AS latitude,
               ST_X(f.pt_4326) AS longitude,
               f.position_source,
               v.osm_street,
               v.osm_housenumber
        FROM final_geom f
        LEFT JOIN _voter_with_osm v ON v.external_id = f.external_id
        UNION ALL
        -- in_complex: OSM centroid for voters inside residential
        -- complex polygons (Stuy Town, Co-op City, …).
        SELECT external_id,
               osm_lat  AS latitude,
               osm_lon  AS longitude,
               'osm_complex' AS position_source,
               osm_street,
               osm_housenumber
        FROM _voter_with_osm
        WHERE in_complex
        UNION ALL
        -- osm_off_segment: OSM centroid for voters whose OSM building
        -- centroid projects strictly outside the matched TIGER
        -- blockface's geometry (osm_frac clamps to 0.0 or 1.0). This
        -- happens when TIGER's address range exceeds its physical line
        -- (e.g., Myrtle Ave 65-XX where 24 houses claim a 43m segment).
        -- Snapping to the clamp endpoint would put the voter at the
        -- wrong end of the wrong segment; using the OSM centroid
        -- places them at their actual building.
        SELECT vof.external_id,
               vof.osm_lat AS latitude,
               vof.osm_lon AS longitude,
               'osm_off_segment' AS position_source,
               vof.osm_street,
               vof.osm_housenumber
        FROM with_osm_frac vof
        WHERE NOT vof.in_complex
          AND vof.osm_lat IS NOT NULL
          AND (vof.osm_frac = 0.0 OR vof.osm_frac = 1.0)
    """)
    print(f"  done in {time.time()-t0:.1f}s")

    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table_suffix,
        version=_current_version(conn),
    )


# ---------------------------------------------------------------------------
# Node 2 – OSM-only matches for voters TIGER couldn't place
# ---------------------------------------------------------------------------


def osm_only_matches(
    persons_decomposed: TableRef,
    persons_best_match: TableRef,
    osm_building_lookup: TableRef,
    blockface_final: TableRef,
    address_tokens: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Voters TIGER couldn't match, rescued by direct OSM lookup.

    For each voter without a `persons_best_match` row, derive a
    canonical_key from their raw address (same STREET_REWRITES +
    equivalency expansion as the OSM side), join to
    `osm_building_lookup` to find their building, then snap to the
    nearest blockface in the same zip5 for downstream consumers that
    need a `blockface_id` (e.g. turf assignment).

    Schema: (external_id, latitude, longitude, osm_street,
             blockface_id, snap_distance_m).

    The snap is informational — `snap_distance_m` reports how far the
    voter is from their associated blockface. Far snaps (e.g. deep
    inside Stuy Town) just mean the building isn't directly on a
    street; the blockface_id is still useful for grouping.

    Non-incremental: drops + recreates every run.
    """
    table_suffix = "osm_only_matches"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table_suffix)

    pd_ = persons_decomposed.fqn
    pbm = persons_best_match.fqn
    obl = osm_building_lookup.fqn
    bf_ = blockface_final.fqn
    tok = address_tokens.fqn

    conn.execute(f"DROP TABLE IF EXISTS {fqn}")

    print("Rescuing TIGER-miss voters via OSM lookup…")
    t0 = time.time()

    # Step 1: keyed TIGER-miss voters
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _miss_raw AS
        SELECT d.external_id, d.zip5,
            {street_rewrite_sql("d.street_name_raw")} AS street_norm,
            regexp_replace(
                regexp_replace(
                    COALESCE(d.house_num_prefix, '')
                      || CAST(d.house_number AS VARCHAR)
                      || CASE WHEN d.half_code IS NOT NULL AND d.half_code != ''
                              THEN ' ' || d.half_code ELSE '' END,
                    '(^|-)0*([0-9])', '\\1\\2', 'g'),
                '-', '', 'g'
            ) AS housenumber_norm
        FROM {pd_} d
        WHERE d.external_id NOT IN (SELECT external_id FROM {pbm})
          AND d.street_name_raw IS NOT NULL
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _miss_keyed AS
        WITH tokens AS (
            SELECT external_id, zip5, housenumber_norm,
                {tokenize_street_sql("street_norm")} AS raw_tokens
            FROM _miss_raw
        ),
        extras AS (
            SELECT b.external_id, flatten(list(t.equivalent_tokens)) AS extra
            FROM tokens b
            JOIN {tok} t ON len(list_intersect(b.raw_tokens, t.equivalent_tokens)) > 0
            GROUP BY b.external_id
        ),
        combined AS (
            SELECT b.external_id, b.zip5, b.housenumber_norm,
                list_distinct(list_concat(b.raw_tokens, COALESCE(e.extra, []))) AS expanded
            FROM tokens b LEFT JOIN extras e USING (external_id)
        )
        SELECT external_id, zip5, housenumber_norm,
            {canonical_key_sql("expanded")} AS canonical_key
        FROM combined
    """)
    n_miss = conn.execute("SELECT count(*) FROM _miss_keyed").fetchone()[0]
    print(f"  {n_miss:,} TIGER-miss voters keyed in {time.time()-t0:.1f}s")

    # Step 2: lookup each in OSM
    print("  joining to osm_building_lookup…")
    t0 = time.time()
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _miss_with_osm AS
        SELECT v.external_id, v.zip5,
               o.osm_lat AS latitude, o.osm_lon AS longitude,
               o.street  AS osm_street,
               o.housenumber AS osm_housenumber
        FROM _miss_keyed v
        JOIN {obl} o
          ON o.zip_code         = v.zip5
         AND o.canonical_key    = v.canonical_key
         AND o.housenumber_norm = v.housenumber_norm
        WHERE v.canonical_key != ''
    """)
    n_osm = conn.execute("SELECT count(*) FROM _miss_with_osm").fetchone()[0]
    print(f"  {n_osm:,} matched to OSM in {time.time()-t0:.1f}s")

    # Step 3: snap each matched voter to nearest blockface in same zip.
    # Many osm_only voters live in the same building (same osm_lat,
    # osm_lon) — apartment blocks especially. Dedupe to distinct
    # (zip, lat, lon), snap each location once, then join back. Cuts
    # the spatial work by 10-50× on dense urban data.
    print("  snapping to nearest blockface in zip…")
    t0 = time.time()
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        WITH distinct_locs AS (
            SELECT DISTINCT zip5, latitude, longitude
            FROM _miss_with_osm
        ),
        candidates AS (
            SELECT v.zip5, v.latitude, v.longitude,
                   b.blockface_id,
                   ST_Distance(
                       ST_Transform(b.geom, 'OGC:CRS84', 'EPSG:32618'),
                       ST_Transform(ST_Point(v.longitude, v.latitude),
                                    'OGC:CRS84', 'EPSG:32618')
                   ) AS d_m
            FROM distinct_locs v
            JOIN {bf_} b ON b.zip_code = v.zip5
        ),
        loc_snaps AS (
            SELECT DISTINCT ON (zip5, latitude, longitude)
                   zip5, latitude, longitude, blockface_id, d_m AS snap_distance_m
            FROM candidates
            -- blockface_id tiebreak so equidistant blockfaces resolve
            -- deterministically; without it the chosen blockface_id can
            -- vary between runs.
            ORDER BY zip5, latitude, longitude, d_m, blockface_id
        )
        SELECT v.external_id, v.latitude, v.longitude, v.osm_street, v.osm_housenumber,
               s.blockface_id, s.snap_distance_m
        FROM _miss_with_osm v
        JOIN loc_snaps s
          ON s.zip5 = v.zip5
         AND s.latitude = v.latitude
         AND s.longitude = v.longitude
    """)
    n_out = conn.execute(f"SELECT count(*) FROM {fqn}").fetchone()[0]
    print(f"  {n_out:,} osm_only voters snapped in {time.time()-t0:.1f}s")

    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table_suffix,
        version=_current_version(conn),
    )
