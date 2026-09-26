"""Autocut: cut a campaign zone's segment buildings into turf drafts.

    turfDrafts.autocut (web) ─► jobs row ─► autocut_turfs
        buildings   segment ∩ zone, doors counted like the cutter's sidebar
        cut         buildings merged into turfs along map neighbours, closest
                    first, up to a cap around the door target
        polygons    each turf's Voronoi cells, trimmed to its hull
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

# How far a turf's polygon reaches past its outermost buildings, and half
# the width of a bridge rejoining a turf the trim split. Ground meters.
_HULL_MARGIN_M = 10.0
_BRIDGE_HALF_WIDTH_M = 8.0
# Kept small: buildings sit about this close to the edges turfs share, so
# coarser simplification moves some into the neighbouring turf.
_SIMPLIFY_M = 5.0

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
    cells. Each link carries the street crossing between the two buildings
    (none along one blockface, the `blockface_relationships` cost between
    two, `_AROUND_BLOCK` when their blockfaces don't meet) and the distance
    between them.

    Turfs absorb their neighbours closest first: along the block before
    across a street, across a quiet street before an avenue, shorter
    distances first within each, never across a barrier. Merging stops
    before a turf would pass the cap. Anything left under the floor joins
    a neighbour anyway, one with room under the cap if there is one, as
    long as some turf is within `_ISOLATED_M`; otherwise it's left out.
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
            SELECT s.a, s.b
            FROM shared s JOIN autocut_sites sa ON sa.site = s.a
            WHERE ST_Dimension(s.edge) = 1
              AND ST_DWithin(s.edge, sa.pt, {_NEIGHBOUR_REACH_M} / cos(radians(sa.latitude)))
        ),
        -- Web Mercator distance to ground meters.
        scale AS (
            SELECT cos(radians(avg(latitude))) AS k FROM autocut_sites
        ),
        -- Buildings at one spot are neighbours too.
        neighbours AS (
            SELECT x.unit_id AS u, y.unit_id AS v, x.blockface_id AS bu, y.blockface_id AS bv,
                   true AS same_site, 0.0 AS distance
            FROM autocut_units x JOIN autocut_units y ON x.site = y.site AND x.unit_id < y.unit_id
            UNION ALL
            SELECT x.unit_id, y.unit_id, x.blockface_id, y.blockface_id,
                   false, ST_Distance(sa.pt, sb.pt) * scale.k
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
            SELECT n.u, n.v, n.distance,
                   CASE WHEN n.same_site OR n.bu = n.bv THEN 0.0 ELSE coalesce(r.w, {_AROUND_BLOCK}) END AS crossing
            FROM neighbours n
            LEFT JOIN rel r ON r.a = least(n.bu, n.bv) AND r.b = greatest(n.bu, n.bv)
        )
        SELECT u, v, distance, crossing FROM pairs UNION ALL SELECT v, u, distance, crossing FROM pairs
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
             legal AS (
                 SELECT p.ca, p.cb, p.link.crossing AS crossing, p.link.distance AS distance,
                        least(sa.doors, sb.doors) < {floor} AS under_floor,
                        sa.doors + sb.doors > {cap} AS over_cap
                 FROM pairs p JOIN sizes sa ON sa.cid = p.ca JOIN sizes sb ON sb.cid = p.cb
                 WHERE sa.doors + sb.doors <= {cap}
                    OR (least(sa.doors, sb.doors) < {floor} AND p.nearest <= {_ISOLATED_M})
             ),
             best AS (
                 SELECT ca,
                        arg_min(cb, (NOT under_floor, over_cap, crossing, distance, least(ca, cb), greatest(ca, cb)))
                          AS cb
                 FROM legal
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

    A turf is its buildings' Voronoi cells, trimmed to their convex hull
    padded a little, so it hugs its buildings instead of filling parks and
    rivers. Cells never overlap, so neither do turfs. Where the trim cuts a
    turf in two (its cells connect outside the hull), a bridge rejoins it:
    for each link between buildings on either side, a strip from one
    building to the point on the edge their cells share nearest the middle
    of the two, and on to the other, kept inside those two cells so it
    can't reach another turf.

    The turfs are then cleaned into an exact coverage (neighbours sharing
    identical edges, which simplification relies on) and simplified
    together. Work happens in Web Mercator, which stretches ground distance
    by 1/cos(latitude). The cutter draws single rings, so holes are filled,
    and a turf sitting in one is absorbed by the turf around it rather
    than drawn twice.
    """
    (k,) = conn.execute("SELECT 1 / cos(radians(avg(latitude))) FROM autocut_sites").fetchone()
    # Buildings sharing a spot share one cell.
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE autocut_site_turfs AS
        SELECT u.site, min(t.turf) AS turf
        FROM autocut_units u JOIN autocut_turfs t USING (building_id)
        GROUP BY u.site
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE autocut_trimmed AS
        WITH turf_cells AS (
            SELECT st.turf, ST_Union_Agg(c.geom) AS geom
            FROM autocut_site_turfs st JOIN autocut_cells c USING (site)
            GROUP BY st.turf
        ),
        hulls AS (
            SELECT st.turf, ST_ConvexHull(ST_Collect(list(s.pt))) AS geom
            FROM autocut_site_turfs st JOIN autocut_sites s USING (site)
            GROUP BY st.turf
        )
        SELECT c.turf,
               ST_CollectionExtract(ST_Intersection(
                   c.geom, ST_Buffer(h.geom, {_HULL_MARGIN_M * k}, 2, 'CAP_ROUND', 'JOIN_MITRE', 2.0)
               ), 3) AS geom
        FROM turf_cells c JOIN hulls h USING (turf)
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE autocut_bridged AS
        WITH pieces AS (
            SELECT turf, row_number() OVER () AS piece, geom
            FROM (SELECT turf, unnest(ST_Dump(geom), recursive := true) FROM autocut_trimmed)
        ),
        split AS (
            SELECT turf FROM pieces GROUP BY turf HAVING count(*) > 1
        ),
        site_pieces AS (
            SELECT st.site, st.turf, p.piece
            FROM autocut_site_turfs st
            JOIN autocut_sites s USING (site)
            JOIN pieces p ON p.turf = st.turf AND ST_Intersects(p.geom, s.pt)
            WHERE st.turf IN (SELECT turf FROM split)
        ),
        -- Links between buildings drawn in different pieces of one turf.
        gaps AS (
            SELECT DISTINCT pa.turf, least(ua.site, ub.site) AS a, greatest(ua.site, ub.site) AS b
            FROM autocut_links l
            JOIN autocut_units ua ON ua.unit_id = l.u
            JOIN autocut_units ub ON ub.unit_id = l.v
            JOIN site_pieces pa ON pa.site = ua.site
            JOIN site_pieces pb ON pb.site = ub.site
            WHERE pa.turf = pb.turf AND pa.piece <> pb.piece
        ),
        bridges AS (
            SELECT g.turf,
                   ST_Union_Agg(ST_CollectionExtract(ST_Intersection(
                       ST_Buffer(
                           ST_MakeLine([
                               sa.pt,
                               ST_LineInterpolatePoint(
                                   ST_LineMerge(ST_Intersection(ca.geom, cb.geom)),
                                   ST_LineLocatePoint(
                                       ST_LineMerge(ST_Intersection(ca.geom, cb.geom)),
                                       ST_Centroid(ST_MakeLine(sa.pt, sb.pt))
                                   )
                               ),
                               sb.pt
                           ]),
                           {_BRIDGE_HALF_WIDTH_M * k}, 2
                       ),
                       ST_Union(ca.geom, cb.geom)
                   ), 3)) AS geom
            FROM gaps g
            JOIN autocut_sites sa ON sa.site = g.a JOIN autocut_sites sb ON sb.site = g.b
            JOIN autocut_cells ca ON ca.site = g.a JOIN autocut_cells cb ON cb.site = g.b
            GROUP BY g.turf
        )
        SELECT t.turf,
               CASE WHEN b.geom IS NULL THEN t.geom ELSE ST_CollectionExtract(ST_Union(t.geom, b.geom), 3) END AS geom
        FROM autocut_trimmed t LEFT JOIN bridges b USING (turf)
    """)
    # Clean and simplify each come back as one collection in input order.
    # Dumping a collection splits multipart members, so parts are regrouped
    # by their member index, carrying each member's turf along.
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE autocut_polygons AS
        WITH cleaned AS (
            SELECT ST_CoverageClean(list(geom ORDER BY turf)) AS geom, list(turf ORDER BY turf) AS turfs
            FROM autocut_bridged
        ),
        regrouped AS (
            SELECT d.path[1] AS i, any_value(turfs)[d.path[1]] AS turf,
                   ST_CollectionExtract(ST_Collect(list(d.geom)), 3) AS geom
            FROM cleaned, unnest(ST_Dump(cleaned.geom)) AS u(d)
            GROUP BY d.path[1]
        ),
        simplified AS (
            SELECT ST_CoverageSimplify(list(geom ORDER BY i), {_SIMPLIFY_M * k}) AS geom, list(turf ORDER BY i) AS turfs
            FROM regrouped
        ),
        turf_shapes AS (
            SELECT turfs[d.path[1]] AS turf, d.geom
            FROM simplified, unnest(ST_Dump(simplified.geom)) AS u(d)
        ),
        pieces AS (
            SELECT turf, unnest(ST_Dump(geom), recursive := true) FROM turf_shapes
        ),
        filled AS (
            SELECT turf, path, ST_MakePolygon(ST_ExteriorRing(geom)) AS geom FROM pieces
        )
        SELECT turf, row_number() OVER (ORDER BY turf, path) AS piece,
               ST_Transform(geom, 'EPSG:3857', 'EPSG:4326', true) AS geom
        FROM filled f
        WHERE NOT EXISTS (
            SELECT 1 FROM filled o
            WHERE (o.turf, o.path) <> (f.turf, f.path) AND ST_Within(f.geom, o.geom)
        )
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
