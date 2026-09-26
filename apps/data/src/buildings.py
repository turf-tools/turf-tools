"""Buildings matching a segment, as the turf cutter sees them.

A building matches when at least one of its persons passes `where`
(compiled by `criteria_to_where` over persons_geocoded), and its door
count is the matching persons' distinct doors, not the building's total.
Both builders return SQL for `resolve()`.
"""


def building_rows_sql(where: str) -> str:
    """One row per matching building: id, centroid, and matching door +
    person counts."""
    return f"""
        SELECT
            b.building_id              AS "buildingId",
            b.longitude,
            b.latitude,
            count(DISTINCT fp.door_i)  AS "doorCount",
            count(*)                   AS "personCount"
        FROM {{buildings_geocoded}} b
        JOIN (
            SELECT building_id, door_i FROM {{persons_geocoded}} {where}
        ) fp ON fp.building_id = b.building_id
        GROUP BY b.building_id, b.longitude, b.latitude
    """


def building_points_sql(where: str) -> str:
    """Matching buildings in MapLibre [0,1] mercator, as deltas from their
    centroid; every row carries the centroid (ox, oy)."""
    return f"""
        WITH pts AS (
            SELECT
                (b.longitude + 180.0) / 360.0 AS mx,
                0.5 - ln(tan(pi()/4 + radians(b.latitude)/2)) / (2*pi()) AS my
            FROM {{buildings_geocoded}} b
            WHERE b.building_i IN (
                SELECT DISTINCT building_i FROM {{persons_geocoded}} {where}
            )
        ),
        o AS (SELECT avg(mx) AS ox, avg(my) AS oy FROM pts)
        SELECT pts.mx - o.ox AS dx, pts.my - o.oy AS dy, o.ox AS ox, o.oy AS oy
        FROM pts, o
    """
