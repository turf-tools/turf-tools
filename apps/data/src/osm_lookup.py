"""How geocoding looks voters up in `osm.addresses_keyed`.

A voter's OSM record shares their canonical street key and normalized house
number (see `src/addressing.py`). Two ways to pick among the records that do:

- By ZIP (`zip_lookup_sql`): the record in the voter's ZIP. One record per
  (zip, key, number): a way (polygon centroid) over a node (doorway point),
  then the lowest `osm_id`, so the pick is deterministic.
- Nearby (`NEARBY_MATCH_M`): for a voter the ZIP lookup misses, the record
  nearest the voter's matched TIGER blockface within that distance, whatever
  ZIP it carries or lacks. Many OSM addresses have no `addr:postcode`, and
  some carry one that's out of date.
"""

from __future__ import annotations

# Furthest an OSM record may sit from the voter's matched blockface to count
# as the voter's building when its ZIP doesn't say so. Buildings stand back
# from the street by tens of metres; a cross-street or next-block address
# with the same number and street key is further.
NEARBY_MATCH_M = 100.0


def zip_lookup_sql(addresses_keyed: str) -> str:
    """One row per (zip_code, canonical_key, housenumber_norm) of `addresses_keyed`
    (a table or a parenthesized subquery), as `osm_lat`/`osm_lon`/`street`/
    `housenumber`/`in_residential_complex`."""
    return f"""
        SELECT zip_code, canonical_key, housenumber_norm, housenumber, street,
               lat AS osm_lat, lon AS osm_lon, in_residential_complex
        FROM (
            SELECT *,
                ROW_NUMBER() OVER (
                    PARTITION BY zip_code, canonical_key, housenumber_norm
                    ORDER BY (kind = 'way') DESC, osm_id
                ) AS rn
            FROM {addresses_keyed}
            WHERE zip_code IS NOT NULL
        )
        WHERE rn = 1
    """
