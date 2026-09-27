"""Autocut: cut a campaign zone's segment buildings into turf drafts.

    turfDrafts.autocut (web) ─► jobs row ─► autocut_turfs
        buildings   segment ∩ zone, doors counted like the cutter's sidebar
        cut         buildings merged into turfs along map neighbours, closest
                    first, up to a cap around the door target, never wrapping
                    around another turf
        polygons    each turf's convex hull, padded a little; where hulls overlap
                    or hold another turf's buildings, the nearest building decides
        drafts      one per turf, replacing the scope's drafts; the cutter reloads them

`cut` is the algorithm; everything around it is plumbing that holds
still while the algorithm changes.
"""

import asyncio
from typing import Any

from pydantic import BaseModel, Field

import duckdb
from src.blockface_topology import BARRIER_COST_M
from src.buildings import building_rows_sql
from src.campaign_scope import load_campaign_scope
from src.custom_fields import query_context
from src.dags.tiger import GEO_CATALOG, TIGER_SCHEMA
from src.dsl.compile import criteria_to_where
from src.dsl.resolve import resolve_criteria
from src.duckdb import OPERATIONAL_PG_ALIAS, query_cursor
from src.job_runner import JobContext, job
from src.settings import get_settings
from src.tables import resolve

# Multiples of the door target: merging stops before a turf would pass
# the cap, and anything under the floor joins a neighbour regardless.
_CAP = 1.25
_FLOOR = 1 / 3

# A turf left under the floor with no other turf this close is left out of
# the cut instead: a lone building far from everything else, which no one
# would sign out as a turf of its own. Ground meters.
_ISOLATED_M = 500.0

# Two buildings are neighbours when their Voronoi cells share an edge within
# this distance of them (the edge is equidistant, so of either one). Half of
# `_ISOLATED_M`: buildings further apart than that are never neighbours.
_NEIGHBOUR_REACH_M = 250.0

# Crossing rank for neighbouring buildings whose blockfaces don't meet,
# e.g. back to back across a block's interior: after any street crossing,
# before a barrier.
_AROUND_BLOCK = 150.0

# How far a turf's polygon reaches past its outermost buildings, so a row
# of buildings draws as a rectangle and a lone building as a square. Ground
# meters. Anything under it is safe for simplification, which never moves
# an edge across a building.
_HULL_MARGIN_M = 5.0
_SIMPLIFY_M = 2.0
# Dividers between turfs are cut this far past the region they divide, so
# they cross the hull outlines instead of ending a hair short of them
# (polygonizing ignores dangling ends). Web Mercator meters.
_DIVIDER_OVERSHOOT_M = 0.5
# Noding leaves the odd sliver or pinhole; nothing this small is geometry.
_SLIVER_M2 = 1.0

_RELATIONSHIPS = f"{GEO_CATALOG}.{TIGER_SCHEMA}.blockface_relationships"


class AutocutTurfsPayload(BaseModel):
    campaign_id: str
    zone_id: str | None
    org_slug: str
    organization_id: str
    door_target: int = Field(gt=0)


@job(task="autocut_turfs")
async def autocut_turfs(payload: AutocutTurfsPayload, ctx: JobContext) -> dict[str, Any]:
    return await asyncio.to_thread(_run, payload)


def _run(payload: AutocutTurfsPayload) -> dict[str, Any]:
    settings = get_settings()
    with query_cursor(settings) as conn:
        version, catalog = query_context(conn, payload.org_slug)
        scope = load_campaign_scope(conn, payload.campaign_id, payload.zone_id)
        criteria = resolve_criteria(scope.criteria, conn, settings, payload.org_slug)
        params: list = []
        where = criteria_to_where(catalog, criteria, scope.key_filter, params)
        conn.execute(
            resolve(
                f"""
                CREATE OR REPLACE TEMP TABLE autocut_buildings AS
                SELECT m."buildingId" AS building_id, m.longitude, m.latitude, m."doorCount" AS doors, g.blockface_id
                FROM ({building_rows_sql(where)}) m
                JOIN {{buildings_geocoded}} g ON g.building_id = m."buildingId"
                """,
                version.schema,
            ),
            params,
        )
        buildings, doors = conn.execute("SELECT count(*), coalesce(sum(doors), 0) FROM autocut_buildings").fetchone()
        if buildings == 0:
            raise ValueError("The segment has no buildings in this zone.")
        cut(conn, payload.door_target)
        _build_polygons(conn)
        turfs = _replace_drafts(conn, payload, scope.segment_id)
    return {"turfs": turfs, "buildings": buildings, "doors": doors}


def cut(conn: duckdb.DuckDBPyConnection, door_target: int) -> None:
    """Assign every building in `autocut_buildings` a turf number in
    `autocut_turfs(building_id, turf)`.

    Agglomerative clustering. Every building starts as its own turf,
    linked to the buildings whose Voronoi cells meet its own within
    `_NEIGHBOUR_REACH_M` of them. Because
    links only join map neighbours, every turf is one connected region of
    cells. Each link carries where the two cells meet, the street crossing between the two buildings
    (none along one blockface, the `blockface_relationships` cost between
    two, `_AROUND_BLOCK` when their blockfaces don't meet) and the distance
    between them.

    Turfs absorb their neighbours closest first: along the block before
    across a street, across a quiet street before an avenue, shorter
    distances first within each, never across a barrier. Merging stops
    before a turf would pass the cap, and keeps every turf drawable as a
    hull: a merge is illegal when the combined turf's convex hull would box
    in another turf's building (its whole cell inside the hull), or when
    the two turfs' cells meet only outside that hull, on the far side of
    someone else's buildings. Anything left under the floor joins a
    neighbour anyway: one it doesn't wrap around if there is one, even past
    the cap, else one with room, since a tiny or uncut turf is worse than
    either; as long as some turf is within `_ISOLATED_M`, otherwise it's
    left out.
    """
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE autocut_sites AS
        SELECT row_number() OVER (ORDER BY longitude, latitude)::INT AS site, longitude, latitude,
               ST_Transform(ST_Point(longitude, latitude), 'EPSG:4326', 'EPSG:3857', true) AS pt
        FROM (SELECT DISTINCT longitude, latitude FROM autocut_buildings)
    """)
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE autocut_cells AS
        WITH cells AS (
            SELECT unnest(ST_Dump(ST_VoronoiDiagram(ST_Collect(list(pt)))), recursive := true) FROM autocut_sites
        )
        SELECT s.site, c.geom FROM autocut_sites s JOIN cells c ON ST_Contains(c.geom, s.pt)
    """)
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE autocut_units AS
        SELECT dense_rank() OVER (ORDER BY b.building_id)::INT AS unit_id,
               b.building_id, b.doors, b.blockface_id, s.site
        FROM autocut_buildings b JOIN autocut_sites s USING (longitude, latitude)
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE autocut_links AS
        -- Cells sharing an edge that comes within reach of the buildings.
        -- At the fringe of the map, outer cells fan out and can meet far
        -- from both buildings; those pairs aren't neighbours.
        WITH shared AS (
            SELECT a.site AS a, b.site AS b, ST_Intersection(a.geom, b.geom) AS edge
            FROM autocut_cells a JOIN autocut_cells b ON a.site < b.site AND ST_Intersects(a.geom, b.geom)
        ),
        touching AS (
            SELECT s.a, s.b, s.edge
            FROM shared s JOIN autocut_sites sa ON sa.site = s.a
            WHERE ST_Dimension(s.edge) = 1
              AND ST_DWithin(s.edge, sa.pt, {_NEIGHBOUR_REACH_M} / cos(radians(sa.latitude)))
        ),
        -- Web Mercator distance to ground meters.
        scale AS (
            SELECT cos(radians(avg(latitude))) AS k FROM autocut_sites
        ),
        -- Buildings at one spot are neighbours too (meeting at that spot).
        neighbours AS (
            SELECT x.unit_id AS u, y.unit_id AS v, x.blockface_id AS bu, y.blockface_id AS bv,
                   true AS same_site, 0.0 AS distance, s.pt AS edge
            FROM autocut_units x JOIN autocut_units y ON x.site = y.site AND x.unit_id < y.unit_id
            JOIN autocut_sites s ON s.site = x.site
            UNION ALL
            SELECT x.unit_id, y.unit_id, x.blockface_id, y.blockface_id,
                   false, ST_Distance(sa.pt, sb.pt) * scale.k, t.edge
            FROM touching t
            JOIN autocut_sites sa ON sa.site = t.a JOIN autocut_sites sb ON sb.site = t.b
            JOIN autocut_units x ON x.site = t.a JOIN autocut_units y ON y.site = t.b, scale
        ),
        rel AS (
            SELECT blockface_id_a AS a, blockface_id_b AS b, min(crossing_cost_m) AS w
            FROM {_RELATIONSHIPS}
            WHERE blockface_id_a IN (SELECT blockface_id FROM autocut_units)
              AND blockface_id_b IN (SELECT blockface_id FROM autocut_units)
            GROUP BY ALL
        ),
        pairs AS (
            SELECT n.u, n.v, n.distance, n.edge,
                   CASE WHEN n.same_site OR n.bu = n.bv THEN 0.0 ELSE coalesce(r.w, {_AROUND_BLOCK}) END AS crossing
            FROM neighbours n
            LEFT JOIN rel r ON r.a = least(n.bu, n.bv) AND r.b = greatest(n.bu, n.bv)
        )
        SELECT u, v, distance, crossing, edge FROM pairs UNION ALL SELECT v, u, distance, crossing, edge FROM pairs
    """)

    cap, floor = _CAP * door_target, _FLOOR * door_target
    # Each round, every turf picks its best legal neighbour and pairs that
    # picked each other merge. The best merge overall is always mutual, so
    # every round makes progress; it stops when no legal merge is left.
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE autocut_turfs AS
        WITH RECURSIVE
        merged(unit_id, cid) USING KEY (unit_id) AS (
            SELECT unit_id, unit_id FROM autocut_units
            UNION
            (WITH sizes AS (
                 SELECT m.cid, sum(u.doors) AS doors
                 FROM recurring.merged m JOIN autocut_units u USING (unit_id)
                 GROUP BY m.cid
             ),
             -- The preferred link between each pair of touching turfs, and
             -- how far apart they are at their closest.
             pairs AS (
                 SELECT a.cid AS ca, b.cid AS cb,
                        min(struct_pack(crossing := l.crossing, distance := l.distance)) AS link,
                        min(l.distance) AS nearest
                 FROM autocut_links l
                 JOIN recurring.merged a ON a.unit_id = l.u
                 JOIN recurring.merged b ON b.unit_id = l.v
                 WHERE a.cid <> b.cid AND l.crossing < {BARRIER_COST_M}
                 GROUP BY ALL
             ),
             -- The hull each candidate merge would have.
             hulls AS (
                 SELECT p.ca, p.cb, ST_ConvexHull(ST_Collect(list(s.pt))) AS hull
                 FROM pairs p
                 JOIN recurring.merged m ON m.cid IN (p.ca, p.cb)
                 JOIN autocut_units u USING (unit_id)
                 JOIN autocut_sites s USING (site)
                 WHERE p.ca < p.cb
                 GROUP BY p.ca, p.cb
             ),
             -- Other turfs' buildings next to either side; a boxed-in
             -- building is always among them.
             around AS (
                 SELECT DISTINCT m.cid, l.v AS unit_id
                 FROM recurring.merged m
                 JOIN autocut_links l ON l.u = m.unit_id
                 JOIN recurring.merged o ON o.unit_id = l.v AND o.cid <> m.cid
             ),
             wrapping AS (
                 SELECT DISTINCT h.ca, h.cb
                 FROM hulls h
                 JOIN around a ON a.cid IN (h.ca, h.cb)
                 JOIN recurring.merged o ON o.unit_id = a.unit_id AND o.cid NOT IN (h.ca, h.cb)
                 JOIN autocut_units u ON u.unit_id = a.unit_id
                 JOIN autocut_cells c USING (site)
                 WHERE ST_Within(c.geom, h.hull)
                 UNION
                 SELECT h.ca, h.cb
                 FROM hulls h
                 WHERE NOT EXISTS (
                     SELECT 1
                     FROM autocut_links l
                     JOIN recurring.merged a ON a.unit_id = l.u AND a.cid = h.ca
                     JOIN recurring.merged b ON b.unit_id = l.v AND b.cid = h.cb
                     WHERE ST_Intersects(l.edge, h.hull)
                 )
             ),
             legal AS (
                 SELECT p.ca, p.cb, p.link.crossing AS crossing, p.link.distance AS distance,
                        least(sa.doors, sb.doors) < {floor} AS under_floor,
                        sa.doors + sb.doors > {cap} AS over_cap,
                        EXISTS (
                            SELECT 1 FROM wrapping w WHERE (w.ca, w.cb) = (least(p.ca, p.cb), greatest(p.ca, p.cb))
                        ) AS wraps
                 FROM pairs p JOIN sizes sa ON sa.cid = p.ca JOIN sizes sb ON sb.cid = p.cb
                 WHERE sa.doors + sb.doors <= {cap}
                    OR (least(sa.doors, sb.doors) < {floor} AND p.nearest <= {_ISOLATED_M})
             ),
             best AS (
                 SELECT ca,
                        arg_min(cb, (NOT under_floor, wraps, over_cap, crossing, distance,
                                     least(ca, cb), greatest(ca, cb))) AS cb
                 FROM legal
                 WHERE NOT wraps OR under_floor
                 GROUP BY ca
             )
             SELECT m.unit_id, b1.cb
             FROM best b1
             JOIN best b2 ON b2.ca = b1.cb AND b2.cb = b1.ca
             JOIN recurring.merged m ON m.cid = b1.ca
             WHERE b1.ca > b1.cb)
        ),
        kept AS (
            SELECT m.cid FROM merged m JOIN autocut_units u USING (unit_id)
            GROUP BY m.cid HAVING sum(u.doors) >= {floor}
        )
        SELECT u.building_id, dense_rank() OVER (ORDER BY m.cid)::INT - 1 AS turf
        FROM autocut_units u JOIN merged m USING (unit_id)
        WHERE m.cid IN (SELECT cid FROM kept)
    """)


def _build_polygons(conn: duckdb.DuckDBPyConnection) -> None:
    """One polygon per turf, in `autocut_polygons`.

    A turf is the convex hull of its buildings, padded by `_HULL_MARGIN_M`
    with square corners, so a row of buildings is a rectangle and a lone
    building a square. Hulls overlap, and a hull often takes in another
    turf's buildings, so the hulls are cut into a planar partition: every
    hull outline plus, wherever two turfs contest an area, the Voronoi
    dividers between their buildings, noded together and polygonized into
    faces. A face goes to the turf with the nearest building among those
    whose hull covers it and those with a building inside a hull covering
    it. Nothing is subtracted from anything, so nothing is left behind.

    Contests are where two hulls overlap (all buildings of both turfs) and
    inside a hull that holds another turf's buildings (its owner's
    buildings and the buildings inside). Because the cut never boxes a
    building in, a turf's faces join up into one polygon, bar the rare
    turf whose buildings sit in two groups with another turf between them.

    The faces are unioned per turf and the coverage simplified together, so
    neighbours keep sharing exact edges. Work happens in Web Mercator,
    which stretches ground distance by 1/cos(latitude). The cutter draws
    single rings, so holes are filled.
    """
    (k,) = conn.execute("SELECT 1 / cos(radians(avg(latitude))) FROM autocut_sites").fetchone()
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE autocut_turf_points AS
        SELECT t.turf, u.building_id, s.pt
        FROM autocut_turfs t JOIN autocut_units u USING (building_id) JOIN autocut_sites s USING (site)
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE autocut_hulls AS
        SELECT turf, ST_Buffer(hull, {_HULL_MARGIN_M * k}, 1, 'CAP_SQUARE', 'JOIN_MITRE', 2.0) AS geom
        FROM (SELECT turf, ST_ConvexHull(ST_Collect(list(pt))) AS hull FROM autocut_turf_points GROUP BY turf)
    """)
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE autocut_contests AS
        SELECT row_number() OVER () AS contest, region, sites
        FROM (
            SELECT ST_CollectionExtract(ST_Intersection(a.geom, b.geom), 3) AS region, list(x.pt) AS sites
            FROM autocut_hulls a
            JOIN autocut_hulls b ON a.turf < b.turf AND ST_Intersects(a.geom, b.geom)
            JOIN autocut_turf_points x ON x.turf IN (a.turf, b.turf)
            GROUP BY a.turf, b.turf, a.geom, b.geom
            HAVING ST_Area(ST_Intersection(a.geom, b.geom)) > 0
            UNION ALL
            SELECT h.geom, list(x.pt)
            FROM autocut_hulls h
            JOIN (
                SELECT DISTINCT h.turf AS hull, x.turf
                FROM autocut_hulls h JOIN autocut_turf_points x ON x.turf <> h.turf AND ST_Contains(h.geom, x.pt)
            ) o ON o.hull = h.turf
            JOIN autocut_turf_points x ON x.turf = h.turf OR (x.turf = o.turf AND ST_Contains(h.geom, x.pt))
            GROUP BY h.turf, o.turf, h.geom
        )
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE autocut_dividers AS
        -- Voronoi cells are clipped to an envelope around their sites; anchors
        -- far outside push it past the contested region.
        WITH sites AS (
            SELECT contest, unnest(sites) AS pt FROM autocut_contests
            UNION ALL
            SELECT contest, unnest([
                ST_Point(ST_XMin(e) - 10000, ST_YMin(e) - 10000), ST_Point(ST_XMax(e) + 10000, ST_YMin(e) - 10000),
                ST_Point(ST_XMax(e) + 10000, ST_YMax(e) + 10000), ST_Point(ST_XMin(e) - 10000, ST_YMax(e) + 10000)
            ])
            FROM autocut_contests, LATERAL (SELECT ST_Envelope(region) AS e) q
        ),
        cells AS (
            SELECT s.contest, any_value(c.region) AS region,
                   unnest(ST_Dump(ST_VoronoiDiagram(ST_Collect(list(s.pt)))), recursive := true)
            FROM sites s JOIN autocut_contests c USING (contest)
            GROUP BY s.contest
        )
        SELECT ST_Intersection(ST_Boundary(geom), ST_Buffer(region, {_DIVIDER_OVERSHOOT_M})) AS geom FROM cells
    """)
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE autocut_faces AS
        WITH lines AS (
            SELECT ST_Boundary(geom) AS geom FROM autocut_hulls
            UNION ALL
            SELECT geom FROM autocut_dividers WHERE NOT ST_IsEmpty(geom)
        ),
        -- A unary union nodes the linework through the snapping overlay,
        -- which converges where plain noding can fail on near-coincident lines.
        noded AS (SELECT ST_Union_Agg(geom) AS geom FROM lines),
        faces AS (SELECT unnest(ST_Dump(ST_Polygonize([geom])), recursive := true) FROM noded)
        SELECT row_number() OVER () AS face, geom, ST_PointOnSurface(geom) AS rep FROM faces
    """)
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE autocut_labelled AS
        WITH covering AS (
            SELECT f.face, h.turf, h.geom FROM autocut_faces f JOIN autocut_hulls h ON ST_Contains(h.geom, f.rep)
        ),
        candidates AS (
            SELECT c.face, x.turf, x.pt FROM covering c JOIN autocut_turf_points x ON x.turf = c.turf
            UNION
            SELECT c.face, x.turf, x.pt FROM covering c JOIN autocut_turf_points x ON ST_Contains(c.geom, x.pt)
        ),
        nearest AS (
            SELECT c.face, arg_min(c.turf, ST_Distance(c.pt, f.rep)) AS turf
            FROM candidates c JOIN autocut_faces f USING (face)
            GROUP BY c.face
        )
        SELECT f.face, n.turf, f.geom FROM autocut_faces f JOIN nearest n USING (face)
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE autocut_polygons AS
        WITH shapes AS (
            SELECT turf, ST_CoverageUnion(list(geom)) AS geom FROM autocut_labelled GROUP BY turf
        ),
        simplified AS (
            SELECT ST_CoverageSimplify(list(geom ORDER BY turf), {_SIMPLIFY_M * k}) AS geom,
                   list(turf ORDER BY turf) AS turfs
            FROM shapes
        ),
        turf_shapes AS (
            SELECT turfs[d.path[1]] AS turf, d.geom FROM simplified, unnest(ST_Dump(simplified.geom)) AS u(d)
        ),
        pieces AS (
            SELECT turf, unnest(ST_Dump(geom), recursive := true) FROM turf_shapes
        ),
        solid AS (
            SELECT turf, ST_MakePolygon(ST_ExteriorRing(geom)) AS geom FROM pieces WHERE ST_Area(geom) > {_SLIVER_M2}
        )
        SELECT turf, row_number() OVER (ORDER BY turf) AS piece,
               ST_Transform(geom, 'EPSG:3857', 'EPSG:4326', true) AS geom
        FROM solid
    """)


def _replace_drafts(conn: duckdb.DuckDBPyConnection, payload: AutocutTurfsPayload, segment_id: str) -> int:
    """Swap the scope's drafts for the new polygons in one transaction;
    returns how many there are."""
    drafts = f"{OPERATIONAL_PG_ALIAS}.app.turf_drafts"
    try:
        conn.execute("BEGIN TRANSACTION")
        conn.execute(
            f"DELETE FROM {drafts} WHERE campaign_id = ?::UUID AND zone_id IS NOT DISTINCT FROM ?::UUID",
            [payload.campaign_id, payload.zone_id],
        )
        conn.execute(
            f"""
            INSERT INTO {drafts} (turf_draft_id, campaign_id, zone_id, segment_id, geometry, sort_order)
            SELECT uuid(), ?::UUID, ?::UUID, ?::UUID, json(ST_AsGeoJSON(geom)), (piece - 1)::INT
            FROM autocut_polygons
            """,
            [payload.campaign_id, payload.zone_id, segment_id],
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return conn.execute("SELECT count(*) FROM autocut_polygons").fetchone()[0]
