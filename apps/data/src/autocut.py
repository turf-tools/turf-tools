"""Autocut: cut a collection of buildings with door counts into turf drafts.

turfDrafts.autocut (web) ─► jobs row ─► autocut_turfs
    buildings   buildings in a segment zone intersection with door counts
    cut         buildings merged into turfs along map neighbours, closest
                first, up to a cap around the door target, never wrapping
                around another turf
    trade       single buildings cross a boundary where that untangles
                two turfs' hulls
    polygons    each turf's hull, padded a little; where hulls overlap or
                hold another turf's buildings, the nearest building decides;
                a turf drawn in pieces gives the buildings of its islands
                to the turf around them and is drawn again
    drafts      one per turf, numbered as a walk from the chosen corner so
                nearby numbers are nearby on the map; they replace the
                scope's drafts and the cutter reloads them
"""

import asyncio
import logging
import math
import time
from typing import Any, Literal

from pydantic import BaseModel, Field

import duckdb
from src.blockface_topology import BARRIER_COST_M, barrier_sql
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

logger = logging.getLogger("uvicorn")

# Multiples of the door target: merging stops before a turf would pass
# the cap, and anything under the floor joins a neighbour regardless.
_CAP = 1.25
_FLOOR = 1 / 3

# No merge reaches further than this between the two nearest buildings:
# a six-minute walk past nobody isn't the same turf, whatever the door
# count says. A turf left under the floor with nothing this close stays
# out of the cut. Ground meters.
_REACH_M = 500.0

# Crossing cost for neighbouring buildings whose blockfaces never meet,
# e.g. back to back across a block's interior, which `blockface_relationships`
# has no row for. Set between the costs in `src/blockface_topology.py` for a
# major road (60) and a barrier (100,000): worse than any street crossing,
# but not forbidden. Unless a barrier lies between the two buildings: those
# blockfaces never meet because of it, and the link is a barrier too.
_AROUND_BLOCK = 150.0

# A turf's hull hugs its buildings: a concave hull, keeping boundary edges
# up to this fraction of the way from the shortest to the longest, so a
# turf that turns a corner doesn't claim the block inside it. 1 is the
# convex hull; below about 0.25 the shapes go spidery.
_HULL_CONCAVITY = 0.5

# How far a turf's polygon reaches past its outermost buildings, so a row
# of buildings draws as a rectangle and a lone building as a square. Ground
# meters. Anything under it is safe for simplification, which never moves
# an edge across a building.
_HULL_MARGIN_M = 5.0
_SIMPLIFY_M = 2.0

# A balance move is a house changing sides along the edge two turfs share;
# a receiver may not reach further than this (ground meters, to its nearest
# building) for one. The merge's reach is a limit on walking past nobody;
# this is tighter because in sparsely built places cells meet across empty
# ground and a turf short of doors would grab a house streets away.
_BALANCE_REACH_M = 150.0
# Every trade round strictly lowers a non-negative total (overlap, then
# squared distance from the target), so this only bounds the unforeseen;
# evening out a sprawling zone moves a few hundred buildings.
_TRADE_MOVES = 1000
# How many steps a transfer may grow by: each redraws the receiver's hull
# and takes in the giver's buildings it newly covers, about one house of
# a street per step. A transfer still growing is left alone.
_TRADE_GROWTH = 5
# Dividers between turfs are cut this far past the region they divide, so
# they cross the hull outlines instead of ending a hair short of them
# (polygonizing ignores dangling ends). Web Mercator meters.
_DIVIDER_OVERSHOOT_M = 0.5
# Noding leaves the odd sliver or pinhole; nothing this small is geometry.
_SLIVER_M2 = 1.0

_RELATIONSHIPS = f"{GEO_CATALOG}.{TIGER_SCHEMA}.blockface_relationships"
_EDGES = f"{GEO_CATALOG}.{TIGER_SCHEMA}.edges"


def _mercator_scale(conn: duckdb.DuckDBPyConnection) -> float:
    """Web Mercator meters per ground meter at the zone's latitude."""
    (k,) = conn.execute("SELECT 1 / cos(radians(avg(latitude))) FROM autocut_sites").fetchone()
    return k


def _hull_sql(points: str, k: float) -> str:
    """SQL for a turf's drawn shape: the concave hull of `points` (a list
    expression), padded by the margin with square corners."""
    return (
        f"ST_Buffer(ST_ConcaveHull(ST_Collect({points}), {_HULL_CONCAVITY}, false), "
        f"{_HULL_MARGIN_M * k}, 1, 'CAP_SQUARE', 'JOIN_MITRE', 2.0)"
    )


class AutocutTurfsPayload(BaseModel):
    campaign_id: str
    zone_id: str | None
    org_slug: str
    door_target: int = Field(gt=0)
    # Read back by the web's status poll to keep jobs to their own org.
    organization_id: str
    start: Literal["northwest", "northeast", "southwest", "southeast"] = "northwest"


@job(task="autocut_turfs")
async def autocut_turfs(payload: AutocutTurfsPayload, ctx: JobContext) -> dict[str, Any]:
    return await asyncio.to_thread(_run, payload)


def _run(payload: AutocutTurfsPayload) -> dict[str, Any]:
    settings = get_settings()
    phases: dict[str, float] = {}

    def done(phase: str, since: float) -> float:
        phases[phase] = time.perf_counter() - since
        return time.perf_counter()

    with query_cursor(settings) as conn:
        t = time.perf_counter()
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
        t = done("buildings", t)
        cut(conn, payload.door_target)
        t = done("cut", t)
        _trade(conn, payload.door_target)
        _balance(conn, payload.door_target)
        _trade(conn, payload.door_target)
        t = done("trade", t)
        _build_polygons(conn)
        _absorb_islands(conn)
        _order_drafts(conn, payload.start)
        t = done("draw", t)
        turfs = _replace_drafts(conn, payload, scope.segment_id)
        done("drafts", t)
    logger.info("autocut %d buildings: %s", buildings, " ".join(f"{k} {v:.2f}s" for k, v in phases.items()))
    return {"turfs": turfs, "buildings": buildings, "doors": doors}


def cut(conn: duckdb.DuckDBPyConnection, door_target: int) -> None:
    """Assign every building in `autocut_buildings` a turf number in
    `autocut_turfs(building_id, turf)`.

    Agglomerative clustering. Every building starts as its own turf,
    linked to the buildings whose Voronoi cells meet its own. Because links
    only join map neighbours, every turf is one connected region of cells.
    Each link carries where the two cells meet, the street crossing between
    the two buildings (none along one blockface, the `blockface_relationships`
    cost between two, `_AROUND_BLOCK` when their blockfaces don't meet, a
    barrier when they don't meet because one lies between) and the distance
    between them.

    Turfs absorb their neighbours closest first: along the block before
    across a street, across a quiet street before an avenue, shorter
    distances first within each, never across a barrier. Merging stops
    before a turf would pass the cap, and keeps every turf drawable as a
    hull: a merge is illegal when the combined turf's hull would box in
    another turf's building (its whole cell inside the hull), or when the
    two turfs' cells meet only outside that hull, on the far side of
    someone else's buildings. Anything left under the floor joins a
    neighbour anyway: one it doesn't wrap around if there is one, even past
    the cap, else one with room, since a tiny or uncut turf is worse than
    either. No merge reaches past `_REACH_M`; a turf under the floor with
    nothing that close is left out.
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
        SELECT s.site, c.geom,
               ST_XMin(c.geom) AS x0, ST_YMin(c.geom) AS y0, ST_XMax(c.geom) AS x1, ST_YMax(c.geom) AS y1
        FROM autocut_sites s JOIN cells c ON ST_Contains(c.geom, s.pt)
    """)
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE autocut_units AS
        SELECT dense_rank() OVER (ORDER BY b.building_id)::INT AS unit_id,
               b.building_id, b.doors, b.blockface_id, s.site
        FROM autocut_buildings b JOIN autocut_sites s USING (longitude, latitude)
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE autocut_barriers AS
        SELECT geom, ST_XMin(geom) AS x0, ST_YMin(geom) AS y0, ST_XMax(geom) AS x1, ST_YMax(geom) AS y1
        FROM {_EDGES}
        WHERE {barrier_sql("feature_class_code")}
          AND ST_Intersects(geom, (
              SELECT ST_Envelope(ST_Collect(list(ST_Point(longitude, latitude)))) FROM autocut_sites
          ))
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE autocut_links AS
        -- Cells sharing an edge. Boxes first, so the pairing is a range
        -- join rather than every cell against every other.
        WITH shared AS (
            SELECT a.site AS a, b.site AS b, ST_Intersection(a.geom, b.geom) AS edge
            FROM autocut_cells a
            JOIN autocut_cells b ON a.site < b.site
             AND b.x1 >= a.x0 AND b.x0 <= a.x1 AND b.y1 >= a.y0 AND b.y0 <= a.y1
            WHERE ST_Intersects(a.geom, b.geom)
        ),
        touching AS (
            SELECT s.a, s.b, s.edge
            FROM shared s JOIN autocut_sites sa ON sa.site = s.a
            WHERE ST_Dimension(s.edge) = 1
        ),
        -- Web Mercator distance to ground meters.
        scale AS (
            SELECT cos(radians(avg(latitude))) AS k FROM autocut_sites
        ),
        -- Buildings at one spot are neighbours too (meeting at that spot).
        neighbours AS (
            SELECT x.unit_id AS u, y.unit_id AS v, x.blockface_id AS bu, y.blockface_id AS bv,
                   true AS same_site, 0.0 AS distance, s.pt AS edge, NULL::GEOMETRY AS line
            FROM autocut_units x JOIN autocut_units y ON x.site = y.site AND x.unit_id < y.unit_id
            JOIN autocut_sites s ON s.site = x.site
            UNION ALL
            SELECT x.unit_id, y.unit_id, x.blockface_id, y.blockface_id,
                   false, ST_Distance(sa.pt, sb.pt) * scale.k, t.edge,
                   ST_MakeLine(ST_Point(sa.longitude, sa.latitude), ST_Point(sb.longitude, sb.latitude))
            FROM touching t
            JOIN autocut_sites sa ON sa.site = t.a JOIN autocut_sites sb ON sb.site = t.b
            JOIN autocut_units x ON x.site = t.a JOIN autocut_units y ON y.site = t.b, scale
        ),
        -- Pairs on different blockfaces with a barrier between them.
        crossed AS (
            SELECT DISTINCT n.u, n.v
            FROM neighbours n
            JOIN autocut_barriers k
              ON k.x1 >= ST_XMin(n.line) AND k.x0 <= ST_XMax(n.line)
             AND k.y1 >= ST_YMin(n.line) AND k.y0 <= ST_YMax(n.line)
            WHERE NOT n.same_site AND n.bu <> n.bv AND ST_Intersects(k.geom, n.line)
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
                   CASE WHEN n.same_site OR n.bu = n.bv THEN 0.0
                        WHEN r.w IS NOT NULL THEN r.w
                        WHEN c.u IS NOT NULL THEN {BARRIER_COST_M}
                        ELSE {_AROUND_BLOCK} END AS crossing
            FROM neighbours n
            LEFT JOIN rel r ON r.a = least(n.bu, n.bv) AND r.b = greatest(n.bu, n.bv)
            LEFT JOIN crossed c ON (c.u, c.v) = (n.u, n.v)
        )
        SELECT u, v, distance, crossing, edge FROM pairs UNION ALL SELECT v, u, distance, crossing, edge FROM pairs
    """)

    cap, floor = _CAP * door_target, _FLOOR * door_target
    conn.execute("CREATE OR REPLACE TEMP TABLE autocut_merged AS SELECT unit_id, unit_id AS cid FROM autocut_units")
    conn.execute("CREATE OR REPLACE TEMP TABLE autocut_blocked (ca INT, cb INT)")
    # Each round, every turf picks its best legal neighbour on doors,
    # crossing and distance alone, and pairs that picked each other are
    # tested for drawability: only those few pairs get a hull built. A pair
    # that fails is blocked, so both turfs pick someone else next round; a
    # turf under the floor whose every partner is blocked takes one anyway,
    # since a tiny or uncut turf is worse than a hull with a bite in it.
    # Every round merges or blocks at least one pair, so it ends.
    # The round's statement is prepared once because it never changes.
    conn.execute(
        "PREPARE autocut_pick AS "
        + f"""
            WITH sizes AS (
                SELECT m.cid, sum(u.doors) AS doors
                FROM autocut_merged m JOIN autocut_units u USING (unit_id)
                GROUP BY m.cid
            ),
            -- The preferred link between each pair of touching turfs, and
            -- how far apart they are at their closest.
            pairs AS (
                SELECT a.cid AS ca, b.cid AS cb,
                       min(struct_pack(crossing := l.crossing, distance := l.distance)) AS link,
                       min(l.distance) AS nearest
                FROM autocut_links l
                JOIN autocut_merged a ON a.unit_id = l.u
                JOIN autocut_merged b ON b.unit_id = l.v
                WHERE a.cid <> b.cid AND l.crossing < {BARRIER_COST_M}
                GROUP BY ALL
            ),
            legal AS (
                SELECT p.ca, p.cb, p.link.crossing AS crossing, p.link.distance AS distance,
                       least(sa.doors, sb.doors) < {floor} AS under_floor,
                       sa.doors + sb.doors > {cap} AS over_cap,
                       EXISTS (
                           SELECT 1 FROM autocut_blocked k
                           WHERE (k.ca, k.cb) = (least(p.ca, p.cb), greatest(p.ca, p.cb))
                       ) AS blocked
                FROM pairs p JOIN sizes sa ON sa.cid = p.ca JOIN sizes sb ON sb.cid = p.cb
                WHERE p.nearest <= {_REACH_M}
                  AND (sa.doors + sb.doors <= {cap} OR least(sa.doors, sb.doors) < {floor})
            ),
            -- A blocked pair is a last resort, and only for a turf under the floor.
            best AS (
                SELECT ca,
                       arg_min(cb, (NOT under_floor, blocked, over_cap, crossing, distance,
                                    least(ca, cb), greatest(ca, cb))) AS cb,
                       arg_min(blocked, (NOT under_floor, blocked, over_cap, crossing, distance,
                                         least(ca, cb), greatest(ca, cb))) AS forced
                FROM legal
                WHERE NOT blocked OR under_floor
                GROUP BY ca
            ),
            mutual AS (
                SELECT b1.ca, b1.cb, b1.forced
                FROM best b1
                JOIN best b2 ON b2.ca = b1.cb AND b2.cb = b1.ca
                WHERE b1.ca < b1.cb
            ),
            -- The hull each picked merge would have, with its box for cheap
            -- tests ahead of the real ones.
            hulls AS (
                SELECT p.ca, p.cb, h.hull,
                       ST_XMin(h.hull) AS x0, ST_YMin(h.hull) AS y0, ST_XMax(h.hull) AS x1, ST_YMax(h.hull) AS y1
                FROM mutual p,
                LATERAL (
                    SELECT ST_ConcaveHull(ST_Collect(list(s.pt)), {_HULL_CONCAVITY}, false) AS hull
                    FROM autocut_merged m JOIN autocut_units u USING (unit_id) JOIN autocut_sites s USING (site)
                    WHERE m.cid IN (p.ca, p.cb)
                ) h
            ),
            -- Other turfs' buildings next to either side; a boxed-in
            -- building is always among them.
            around AS (
                SELECT DISTINCT m.cid, l.v AS unit_id
                FROM autocut_merged m
                JOIN autocut_links l ON l.u = m.unit_id
                JOIN autocut_merged o ON o.unit_id = l.v AND o.cid <> m.cid
                WHERE m.cid IN (SELECT ca FROM mutual UNION ALL SELECT cb FROM mutual)
            ),
            around_cells AS (
                SELECT a.cid, a.unit_id, o.cid AS other, c.geom,
                       ST_XMin(c.geom) AS x0, ST_YMin(c.geom) AS y0, ST_XMax(c.geom) AS x1, ST_YMax(c.geom) AS y1
                FROM around a
                JOIN autocut_merged o ON o.unit_id = a.unit_id
                JOIN autocut_units u ON u.unit_id = a.unit_id
                JOIN autocut_cells c USING (site)
            ),
            -- Boxed in: the cell's box fits the hull's box, then the cell fits the hull.
            boxed AS (
                SELECT DISTINCT h.ca, h.cb
                FROM hulls h
                JOIN around_cells c ON c.cid = h.ca
                WHERE c.other <> h.cb
                  AND c.x0 >= h.x0 AND c.y0 >= h.y0 AND c.x1 <= h.x1 AND c.y1 <= h.y1
                  AND ST_Within(c.geom, h.hull)
                UNION
                SELECT DISTINCT h.ca, h.cb
                FROM hulls h
                JOIN around_cells c ON c.cid = h.cb
                WHERE c.other <> h.ca
                  AND c.x0 >= h.x0 AND c.y0 >= h.y0 AND c.x1 <= h.x1 AND c.y1 <= h.y1
                  AND ST_Within(c.geom, h.hull)
            ),
            -- Meeting inside: some link between the two crosses the hull.
            meeting AS (
                SELECT DISTINCT h.ca, h.cb
                FROM hulls h
                JOIN autocut_merged a ON a.cid = h.ca
                JOIN autocut_links l ON l.u = a.unit_id
                JOIN autocut_merged b ON b.unit_id = l.v AND b.cid = h.cb
                WHERE ST_XMax(l.edge) >= h.x0 AND ST_XMin(l.edge) <= h.x1
                  AND ST_YMax(l.edge) >= h.y0 AND ST_YMin(l.edge) <= h.y1
                  AND ST_Intersects(l.edge, h.hull)
            ),
            wrapping AS (
                SELECT ca, cb FROM boxed
                UNION
                SELECT ca, cb FROM hulls WHERE (ca, cb) NOT IN (SELECT ca, cb FROM meeting)
            )
            SELECT m.ca, m.cb, m.forced, EXISTS (SELECT 1 FROM wrapping w WHERE (w.ca, w.cb) = (m.ca, m.cb)) AS wraps
            FROM mutual m
        """
    )
    while True:
        picked = conn.execute("EXECUTE autocut_pick").fetchall()
        if not picked:
            break
        merges = [(ca, cb) for ca, cb, forced, wraps in picked if not wraps or forced]
        blocks = [(ca, cb) for ca, cb, forced, wraps in picked if wraps and not forced]
        if merges:
            conn.execute(f"""
                UPDATE autocut_merged SET cid = v.ca
                FROM (VALUES {", ".join(f"({ca}, {cb})" for ca, cb in merges)}) v(ca, cb)
                WHERE autocut_merged.cid = v.cb
            """)
        if blocks:
            conn.execute(f"INSERT INTO autocut_blocked VALUES {', '.join(f'({ca}, {cb})' for ca, cb in blocks)}")
    conn.execute("DEALLOCATE autocut_pick")
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE autocut_turfs AS
        WITH kept AS (
            SELECT m.cid FROM autocut_merged m JOIN autocut_units u USING (unit_id)
            GROUP BY m.cid HAVING sum(u.doors) >= {floor}
        )
        SELECT u.building_id, dense_rank() OVER (ORDER BY m.cid)::INT - 1 AS turf
        FROM autocut_units u JOIN autocut_merged m USING (unit_id)
        WHERE m.cid IN (SELECT cid FROM kept)
    """)


def _hulls_sql(k: float) -> str:
    """Every turf's padded hull, doors and box, from `autocut_trade`."""
    return f"""
        SELECT turf, {_hull_sql("list(pt)", k)} AS hull, sum(doors) AS doors,
               min(ST_X(pt)) AS x0, min(ST_Y(pt)) AS y0, max(ST_X(pt)) AS x1, max(ST_Y(pt)) AS y1
        FROM autocut_trade GROUP BY turf
    """


def _overlapping_sql(m: float) -> str:
    """Pairs of overlapping hulls and their overlap, given a `hulls` CTE."""
    return f"""
        SELECT a.turf AS ta, b.turf AS tb, ST_Area(ST_Intersection(a.hull, b.hull)) AS area
        FROM hulls a
        JOIN hulls b ON a.turf < b.turf
         AND b.x1 >= a.x0 - {2 * m} AND b.x0 <= a.x1 + {2 * m}
         AND b.y1 >= a.y0 - {2 * m} AND b.y0 <= a.y1 + {2 * m}
        WHERE ST_Intersects(a.hull, b.hull)
    """


def _transfers_sql(k: float, keys: str, steps: int = _TRADE_GROWTH) -> str:
    """The buildings that move together from a giving turf to a receiving one.

    A transfer starts from the buildings in `transfer0` and grows: redraw
    the receiver's hull with them inside, and any giver building the new
    hull now covers joins too, provided a passable link reaches it; repeat
    until the hull covers nothing more of the giver. Moving the first house
    of a street alone would only drag the hull over the next one. A transfer
    that would have to cross a barrier to take a covered house never
    settles, so it never moves.

    Produces, for each candidate identified by `keys` (`own` the giver,
    `other` the receiver, optionally a `seed`): `hull1..N` and
    `transfer1..N` after each step, `transfers` for the ones that settled
    with their ids and doors, and `after` with both hulls once moved, `ha`
    the giver's without them and `hb` the receiver's with them.

    Unrolled rather than recursive: each step is one grouped hull per
    candidate that grew in the step before.
    """
    cols = keys.split(", ")
    p = ", ".join(f"p.{c}" for c in cols)
    h = ", ".join(f"h.{c}" for c in cols)
    r = ", ".join(f"r.{c}" for c in cols)
    s = ", ".join(f"s.{c}" for c in cols)
    t = ", ".join(f"t.{c}" for c in cols)
    g = ", ".join(f"g.{c}" for c in cols)
    grow = ""
    for i in range(1, steps + 1):
        # Only a transfer that grew last step needs its hull redrawn and
        # its coverage rechecked; the rest carry the previous step's.
        if i == 1:
            grew = f"grew1 AS (SELECT {keys} FROM transfer0 GROUP BY {keys})"
        else:
            grew = f"""grew{i} AS (
                SELECT {keys} FROM transfer{i - 1} t GROUP BY {keys}
                HAVING count(*) > (SELECT count(*) FROM transfer{i - 2} s WHERE ({s}) = ({t}))
            )"""
        carried = (
            ""
            if i == 1
            else f"""
                UNION ALL
                SELECT {keys}, hull FROM hull{i - 1} h
                WHERE NOT EXISTS (SELECT 1 FROM grew{i} g WHERE ({g}) = ({h}))"""
        )
        grow += f"""
            {grew},
            hull{i} AS (
                SELECT {keys}, {_hull_sql("list(pt)", k)} AS hull
                FROM (SELECT {p}, x.pt FROM pairs p JOIN autocut_trade x ON x.turf = p.other
                      UNION ALL SELECT {keys}, pt FROM transfer{i - 1}) q
                WHERE EXISTS (SELECT 1 FROM grew{i} g WHERE ({g}) = ({", ".join(f"q.{c}" for c in cols)}))
                GROUP BY {keys}{carried}
            ),
            transfer{i} AS (
                SELECT * FROM transfer{i - 1}
                UNION ALL
                SELECT {h}, x.id, x.pt, x.doors
                FROM grew{i} g
                JOIN hull{i} h ON ({h}) = ({g})
                JOIN autocut_trade x ON x.turf = h.own AND ST_Within(x.pt, h.hull)
                WHERE NOT EXISTS (SELECT 1 FROM transfer{i - 1} s WHERE ({s}, s.id) = ({h}, x.id))
                  AND EXISTS (
                      SELECT 1 FROM autocut_links l JOIN autocut_trade y ON y.id = l.v
                      WHERE l.u = x.id AND l.crossing < {BARRIER_COST_M}
                        AND (y.turf = h.other
                             OR EXISTS (SELECT 1 FROM transfer{i - 1} s WHERE ({s}, s.id) = ({h}, y.id)))
                  )
            ),"""
    last = steps
    return f"""{grow}
            -- A transfer is settled when its hull covers nothing more of the
            -- giver, so a house it can't take (behind a barrier) blocks it;
            -- that hull is then the receiver's hull after the move.
            transfers AS (
                SELECT {r}, list(r.id) AS ids, sum(r.doors) AS doors
                FROM transfer{last - 1} r
                GROUP BY {r}
                HAVING NOT EXISTS (
                    SELECT 1 FROM hull{last} h JOIN autocut_trade x ON x.turf = h.own AND ST_Within(x.pt, h.hull)
                    WHERE ({h}) = ({r}) AND NOT list_contains(list(r.id), x.id)
                )
            ),
            after AS (
                SELECT {r}, r.ids, r.doors, h.hull AS hb,
                       {_hull_sql("list(x.pt) FILTER (WHERE NOT list_contains(r.ids, x.id))", k)} AS ha
                FROM transfers r
                JOIN hull{last} h ON ({h}) = ({r})
                JOIN autocut_trade x ON x.turf = r.own
                GROUP BY {r}, r.ids, r.doors, h.hull
            ),"""


def _apply_transfers(
    conn: duckdb.DuckDBPyConnection, k: float, found: list, total_sql: str, total: float
) -> tuple[list, float]:
    """Apply one round of transfers, `found` as (giver, receiver, ids) in
    order of preference, `total` the current value of `total_sql`; returns
    the transfers applied and the total afterwards.

    The giving turf must stay in one piece: connected through links that
    meet inside its hull (the hull before the move; a move can only trim
    it). Checked in Python, in order, for the moves that make the batch:
    the recursive walk is cheap here and dear as a subquery per candidate.
    Transfers touching different turfs are applied together; two can still
    affect each other, so a round that fails to lower the total is undone
    in favour of its first move alone, which always lowers it.
    """
    givers = ", ".join(map(str, {own for own, _, _ in found}))
    # Every building of a giving turf, with the links among them that meet
    # inside its hull; a building without any comes with a NULL partner.
    members: dict[int, set[int]] = {}
    links: dict[int, dict[int, set[int]]] = {}
    for turf, u, v in conn.execute(f"""
        SELECT a.turf, a.id, b.id
        FROM autocut_trade a
        JOIN (SELECT turf, {_hull_sql("list(pt)", k)} AS hull FROM autocut_trade GROUP BY turf) h ON h.turf = a.turf
        LEFT JOIN autocut_links l ON l.u = a.id AND ST_Intersects(l.edge, h.hull)
        LEFT JOIN autocut_trade b ON b.id = l.v AND b.turf = a.turf
        WHERE a.turf IN ({givers})
    """).fetchall():
        members.setdefault(turf, set()).add(u)
        if v is not None:
            links.setdefault(turf, {}).setdefault(u, set()).add(v)

    touched: set[int] = set()
    batch = []
    for own, other, ids in found:
        if own not in touched and other not in touched and _connected(members[own] - set(ids), links.get(own, {})):
            touched.update((own, other))
            batch.append((own, other, ids))
    if not batch:
        return [], total
    conn.executemany(
        "UPDATE autocut_trade SET turf = ? WHERE id = ?",
        [(other, b) for _, other, ids in batch for b in ids],
    )
    (after,) = conn.execute(total_sql).fetchone()
    if after >= total:
        keep = batch[:1] if len(batch) > 1 else []
        conn.executemany(
            "UPDATE autocut_trade SET turf = ? WHERE id = ?",
            [(own, b) for own, _, ids in batch[len(keep) :] for b in ids],
        )
        batch = keep
        (after,) = conn.execute(total_sql).fetchone()
    return batch, after


def _trade(conn: duckdb.DuckDBPyConnection, door_target: int) -> int:
    """Untangle neighbouring turfs after the cut; returns how many buildings
    moved.

    Merging never reconsiders a building once absorbed, so two turfs often
    overlap at their edge. A trade hands buildings from one turf to its
    neighbour: the ones sitting inside the neighbour's padded hull, plus
    any that hull would cover once it includes those, moved together as
    one transfer (`_transfers_sql`). A trade only happens if it strictly
    shrinks the total overlap between hulls (a concave hull can reshape as
    points come and go), the giver's hull no longer covers the transfer,
    and both turfs stay
    within cap and floor and in one piece. Street-level trades go before
    around-the-block ones. Every round lowers one non-negative total, so
    it ends.
    """
    cap, floor = _CAP * door_target, _FLOOR * door_target
    k = _mercator_scale(conn)
    m = _HULL_MARGIN_M * k
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE autocut_trade AS
        SELECT t.turf, u.unit_id AS id, u.building_id, u.doors, s.pt
        FROM autocut_turfs t JOIN autocut_units u USING (building_id) JOIN autocut_sites s USING (site)
    """)
    overlap_sql = f"""
        WITH hulls AS ({_hulls_sql(k)})
        SELECT coalesce(sum(ST_Area(ST_Intersection(a.hull, b.hull))), 0)
        FROM hulls a
        JOIN hulls b ON a.turf < b.turf
         AND b.x1 >= a.x0 - {2 * m} AND b.x0 <= a.x1 + {2 * m}
         AND b.y1 >= a.y0 - {2 * m} AND b.y0 <= a.y1 + {2 * m}
        WHERE ST_Intersects(a.hull, b.hull)
    """
    moves = 0
    (total,) = conn.execute(overlap_sql).fetchone()
    conn.execute(
        "PREPARE autocut_trade_round AS "
        + f"""
            WITH hulls AS ({_hulls_sql(k)}),
            overlapping AS ({_overlapping_sql(m)}),
            pairs AS (
                SELECT ta AS own, tb AS other FROM overlapping WHERE area > 0
                UNION ALL
                SELECT tb, ta FROM overlapping WHERE area > 0
            ),
            -- The giver's buildings inside the receiver's hull.
            transfer0 AS (
                SELECT p.own, p.other, x.id, x.pt, x.doors
                FROM pairs p
                JOIN hulls hb ON hb.turf = p.other
                JOIN autocut_trade x ON x.turf = p.own AND ST_Within(x.pt, hb.hull)
            ),{_transfers_sql(k, "own, other")}
            legal AS (
                SELECT a.own, a.other, a.ids, a.ha, a.hb
                FROM after a
                JOIN hulls ga ON ga.turf = a.own
                JOIN hulls gb ON gb.turf = a.other
                WHERE gb.doors + a.doors <= {cap} AND ga.doors - a.doors >= {floor}
                  AND NOT EXISTS (
                      SELECT 1 FROM autocut_trade x
                      WHERE x.turf = a.own AND list_contains(a.ids, x.id) AND ST_Within(x.pt, a.ha)
                  )
            ),
            -- The cheapest link the transfer moves over; one without any stays.
            via AS (
                SELECT l.own, l.other, min(k.crossing) AS via
                FROM legal l
                JOIN autocut_trade x ON x.turf = l.own AND list_contains(l.ids, x.id)
                JOIN autocut_links k ON k.u = x.id
                JOIN autocut_trade y ON y.id = k.v AND y.turf = l.other
                GROUP BY l.own, l.other
            ),
            -- Overlap involving either turf, before and after (with each
            -- other and with any third turf).
            before AS (
                SELECT l.own, l.other, coalesce(sum(o.area), 0) AS area
                FROM legal l
                LEFT JOIN overlapping o ON o.ta IN (l.own, l.other) OR o.tb IN (l.own, l.other)
                GROUP BY l.own, l.other
            ),
            after_area AS (
                SELECT l.own, l.other,
                       ST_Area(ST_Intersection(l.ha, l.hb))
                     + coalesce((SELECT sum(ST_Area(ST_Intersection(l.ha, h.hull))) FROM hulls h
                                 WHERE h.turf NOT IN (l.own, l.other) AND ST_Intersects(l.ha, h.hull)), 0)
                     + coalesce((SELECT sum(ST_Area(ST_Intersection(l.hb, h.hull))) FROM hulls h
                                 WHERE h.turf NOT IN (l.own, l.other) AND ST_Intersects(l.hb, h.hull)), 0) AS area
                FROM legal l
            ),
            gains AS (
                SELECT l.own, l.other, l.ids, v.via, b.area - aa.area AS gain
                FROM legal l
                JOIN via v USING (own, other)
                JOIN before b USING (own, other)
                JOIN after_area aa USING (own, other)
                WHERE b.area - aa.area > 0.5
            )
            SELECT own, other, ids FROM gains ORDER BY via >= {_AROUND_BLOCK}, gain DESC, own, other
        """
    )
    while moves < _TRADE_MOVES:
        found = conn.execute("EXECUTE autocut_trade_round").fetchall()
        if not found:
            break
        batch, total = _apply_transfers(conn, k, found, overlap_sql, total)
        if not batch:
            break
        moves += sum(len(ids) for _, _, ids in batch)
    conn.execute("DEALLOCATE autocut_trade_round")
    conn.execute("""
        UPDATE autocut_turfs SET turf = p.turf FROM autocut_trade p WHERE autocut_turfs.building_id = p.building_id
    """)
    return moves


def _balance(conn: duckdb.DuckDBPyConnection, door_target: int) -> int:
    """Even out the turfs merging left far from the target; returns how
    many buildings moved.

    Greedy merging fills turfs to the cap and leaves the change: a turf of
    thirty doors whose neighbours are all too full to take it. A balance
    move hands buildings from a bigger neighbour to a turf under the band
    (or from a turf over it), a transfer at a time: one of the giver's
    buildings linked to the receiver, plus any the receiver's hull covers
    once redrawn around it. The move stands when it brings the pair's
    sizes closer to the target in sum of squares, the giver's hull no
    longer covers the transfer, the overlap between hulls doesn't grow, the
    house is within `_BALANCE_REACH_M` of the receiver, and both turfs
    stay within cap and floor and in one piece. Cheaper crossings go
    first, as in merging, then the transfer that grows the receiver's hull
    least, so a turf fills in along its edge rather than reaching. Every
    round
    lowers the total squared distance from the target, so it ends.
    """
    cap, floor = _CAP * door_target, _FLOOR * door_target
    # Out of balance: over the cap, or as far under the target as the cap is over.
    lo, hi = (2 - _CAP) * door_target, _CAP * door_target
    k = _mercator_scale(conn)
    m = _HULL_MARGIN_M * k
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE autocut_trade AS
        SELECT t.turf, u.unit_id AS id, u.building_id, u.doors, s.pt
        FROM autocut_turfs t JOIN autocut_units u USING (building_id) JOIN autocut_sites s USING (site)
    """)
    total_sql = f"""
        SELECT sum(power(doors - {door_target}, 2))
        FROM (SELECT sum(doors) AS doors FROM autocut_trade GROUP BY turf)
    """
    moves = 0
    (total,) = conn.execute(total_sql).fetchone()
    conn.execute(
        "PREPARE autocut_balance_round AS "
        + f"""
            WITH hulls AS ({_hulls_sql(k)}),
            overlapping AS ({_overlapping_sql(m)}),
            -- A giver's building linked into a smaller neighbour, where
            -- one of the two is out of the band.
            pairs AS (
                SELECT x.turf AS own, y.turf AS other, x.id AS seed, min(l.crossing) AS via
                FROM autocut_links l
                JOIN autocut_trade x ON x.id = l.u
                JOIN autocut_trade y ON y.id = l.v AND y.turf <> x.turf
                JOIN hulls ga ON ga.turf = x.turf
                JOIN hulls gb ON gb.turf = y.turf
                WHERE l.crossing < {BARRIER_COST_M} AND ga.doors > gb.doors
                  AND (gb.doors < {lo} OR ga.doors > {hi})
                GROUP BY x.turf, y.turf, x.id
                -- Offered to several, a building goes across its cheapest crossing, as in merging.
                QUALIFY via = min(via) OVER (PARTITION BY x.turf, x.id)
            ),
            transfer0 AS (
                SELECT p.own, p.other, p.seed, x.id, x.pt, x.doors
                FROM pairs p JOIN autocut_trade x ON x.id = p.seed
            ),{_transfers_sql(k, "own, other, seed")}
            legal AS (
                SELECT a.own, a.other, a.seed, a.ids, a.doors, ga.doors - gb.doors AS gap, a.ha, a.hb,
                       power(ga.doors - {door_target}, 2) + power(gb.doors - {door_target}, 2)
                       - power(ga.doors - a.doors - {door_target}, 2)
                       - power(gb.doors + a.doors - {door_target}, 2) AS gain,
                       ST_Area(a.hb) - ST_Area(gb.hull) AS grown
                FROM after a
                JOIN hulls ga ON ga.turf = a.own
                JOIN hulls gb ON gb.turf = a.other
                WHERE gb.doors + a.doors <= {cap} AND ga.doors - a.doors >= {floor}
                  AND NOT EXISTS (
                      SELECT 1 FROM autocut_trade x
                      WHERE x.turf = a.own AND list_contains(a.ids, x.id) AND ST_Within(x.pt, a.ha)
                  )
                  AND (SELECT min(ST_Distance(y.pt, sd.pt)) FROM autocut_trade y, autocut_trade sd
                       WHERE y.turf = a.other AND sd.id = a.seed) <= {_BALANCE_REACH_M * k}
            ),
            before AS (
                SELECT l.own, l.other, coalesce(sum(o.area), 0) AS area
                FROM (SELECT DISTINCT own, other FROM legal) l
                LEFT JOIN overlapping o ON o.ta IN (l.own, l.other) OR o.tb IN (l.own, l.other)
                GROUP BY l.own, l.other
            ),
            after_area AS (
                SELECT l.own, l.other, l.seed,
                       ST_Area(ST_Intersection(l.ha, l.hb))
                     + coalesce((SELECT sum(ST_Area(ST_Intersection(l.ha, h.hull))) FROM hulls h
                                 WHERE h.turf NOT IN (l.own, l.other) AND ST_Intersects(l.ha, h.hull)), 0)
                     + coalesce((SELECT sum(ST_Area(ST_Intersection(l.hb, h.hull))) FROM hulls h
                                 WHERE h.turf NOT IN (l.own, l.other) AND ST_Intersects(l.hb, h.hull)), 0) AS area
                FROM legal l
            ),
            moves AS (
                SELECT l.own, l.other, l.seed, l.ids, l.doors, l.gap, l.grown, p.via
                FROM legal l
                JOIN pairs p USING (own, other, seed)
                JOIN before b USING (own, other)
                JOIN after_area aa USING (own, other, seed)
                WHERE l.gain > 0 AND aa.area <= b.area + 0.5
            ),
            -- A pair takes several transfers a round, in order, as long as they
            -- stay short of the gap; each was judged alone, so the trade
            -- pass that follows settles anything they contest together.
            packed AS (
                SELECT own, other, ids, doors, via, grown,
                       sum(doors) OVER (PARTITION BY own, other ORDER BY via, grown, seed
                                        ROWS UNBOUNDED PRECEDING) - doors AS taken, gap
                FROM moves
            )
            SELECT own, other, list_distinct(flatten(list(ids ORDER BY via, grown)))
            FROM packed WHERE taken + doors < gap
            GROUP BY own, other
            ORDER BY min(via), min(grown), own, other
        """
    )
    while moves < _TRADE_MOVES:
        found = conn.execute("EXECUTE autocut_balance_round").fetchall()
        if not found:
            break
        batch, total = _apply_transfers(conn, k, found, total_sql, total)
        if not batch:
            break
        moves += sum(len(ids) for _, _, ids in batch)
    conn.execute("DEALLOCATE autocut_balance_round")
    conn.execute("""
        UPDATE autocut_turfs SET turf = p.turf FROM autocut_trade p WHERE autocut_turfs.building_id = p.building_id
    """)
    return moves


def _connected(nodes: set[int], edges: dict[int, set[int]]) -> bool:
    """Whether `nodes` is one piece under `edges` (adjacency sets)."""
    start = min(nodes)
    seen = {start}
    frontier = [start]
    while frontier:
        found = {v for u in frontier for v in edges.get(u, ()) if v in nodes} - seen
        seen |= found
        frontier = list(found)
    return seen == nodes


def _build_polygons(conn: duckdb.DuckDBPyConnection) -> None:
    """One polygon per turf, in `autocut_polygons`.

    A turf is the concave hull of its buildings (`_HULL_CONCAVITY`), padded
    by `_HULL_MARGIN_M` with square corners, so a row of buildings is a
    rectangle and a lone building a square. Hulls overlap, and a hull can
    take in another turf's buildings, so the hulls are cut into a planar
    partition: every hull outline plus, wherever two turfs contest an area,
    the Voronoi dividers between their buildings, noded together and
    polygonized into faces. A face goes to the turf with the nearest
    building among those whose hull covers it and those with a building
    inside a hull covering it. Nothing is subtracted from anything, so
    nothing is left behind.

    Contests are where two hulls overlap (all buildings of both turfs) and
    inside a hull that holds another turf's buildings (its owner's
    buildings and the buildings inside).

    The faces are unioned per turf and the coverage simplified together, so
    neighbours keep sharing exact edges. Work happens in Web Mercator,
    which stretches ground distance by 1/cos(latitude). The cutter draws
    single rings, so holes are filled. A turf drawn in more than one piece
    gets one row per piece; `_absorb_islands` settles those.
    """
    k = _mercator_scale(conn)
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE autocut_turf_points AS
        SELECT t.turf, u.building_id, s.pt
        FROM autocut_turfs t JOIN autocut_units u USING (building_id) JOIN autocut_sites s USING (site)
    """)
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE autocut_hulls AS
        SELECT turf, {_hull_sql("list(pt)", k)} AS geom FROM autocut_turf_points GROUP BY turf
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
        SELECT turf, ST_Transform(geom, 'EPSG:3857', 'EPSG:4326', true) AS geom FROM solid
    """)


def _absorb_islands(conn: duckdb.DuckDBPyConnection) -> None:
    """A turf must be one draft. A turf drawn in pieces gives the buildings
    of all but its largest piece to the turf whose buildings are nearest,
    and everything is drawn again. Each pass settles every turf it touches;
    the loop only guards against a move creating a new split.
    """
    for _ in range(3):
        moved = conn.execute("""
            WITH pieces AS (
                SELECT p.turf, row_number() OVER () AS piece,
                       ST_Transform(p.geom, 'EPSG:4326', 'EPSG:3857', true) AS geom,
                       count(*) OVER (PARTITION BY p.turf) AS n
                FROM autocut_polygons p
            ),
            members AS (
                SELECT t.building_id, t.turf, s.pt
                FROM autocut_turfs t JOIN autocut_units u USING (building_id) JOIN autocut_sites s USING (site)
            ),
            held AS (
                SELECT p.turf, p.piece, count(m.building_id) AS bldgs
                FROM pieces p LEFT JOIN members m ON m.turf = p.turf AND ST_DWithin(p.geom, m.pt, 0.05)
                WHERE p.n > 1 GROUP BY p.turf, p.piece
            ),
            main AS (SELECT turf, arg_max(piece, bldgs) AS piece FROM held GROUP BY turf),
            stranded AS (
                SELECT m.building_id, m.turf, m.pt
                FROM members m JOIN pieces p ON p.turf = m.turf AND p.n > 1 AND ST_DWithin(p.geom, m.pt, 0.05)
                JOIN main ON main.turf = p.turf AND main.piece <> p.piece
            )
            SELECT s.building_id, arg_min(o.turf, ST_Distance(o.pt, s.pt)) AS turf
            FROM stranded s JOIN members o ON o.turf <> s.turf
            GROUP BY s.building_id
        """).fetchall()
        if not moved:
            return
        conn.execute("CREATE OR REPLACE TEMP TABLE autocut_moves (building_id VARCHAR, turf INT)")
        conn.executemany("INSERT INTO autocut_moves VALUES (?, ?)", moved)
        conn.execute("""
            UPDATE autocut_turfs SET turf = m.turf FROM autocut_moves m WHERE autocut_turfs.building_id = m.building_id
        """)
        _build_polygons(conn)


def _order_drafts(conn: duckdb.DuckDBPyConnection, start: str) -> None:
    """Sensible numbering of drafts: start at the turf furthest toward the
    chosen corner (north-west = the most northerly and westerly at once),
    then the next pick is the nearest turf not yet numbered. That walk
    strands the odd turf it steps past, so it's then untangled:
    any stretch of the sequence whose reversal shortens the walk is
    reversed, until none does (2-opt, with the start pinned).
    """
    rows = conn.execute("""
        SELECT turf, ST_X(c), ST_Y(c)
        FROM (SELECT turf, ST_Centroid(ST_Transform(geom, 'EPSG:4326', 'EPSG:3857', true)) AS c FROM autocut_polygons)
    """).fetchall()
    at = {turf: (x, y) for turf, x, y in rows}
    east, north = {
        "northwest": (-1, 1),
        "northeast": (1, 1),
        "southwest": (-1, -1),
        "southeast": (1, -1),
    }[start]
    dist = lambda a, b: math.dist(at[a], at[b])  # noqa: E731

    left = set(at)
    path = [max(left, key=lambda t: east * at[t][0] + north * at[t][1])]
    left.remove(path[0])
    while left:
        path.append(min(left, key=lambda t: dist(path[-1], t)))
        left.remove(path[-1])

    n = len(path)
    improved = True
    while improved:
        improved = False
        for i in range(1, n - 1):
            for j in range(i + 1, n):
                before = dist(path[i - 1], path[i]) + (dist(path[j], path[j + 1]) if j + 1 < n else 0)
                after = dist(path[i - 1], path[j]) + (dist(path[i], path[j + 1]) if j + 1 < n else 0)
                if after < before - 1e-6:
                    path[i : j + 1] = reversed(path[i : j + 1])
                    improved = True

    conn.execute("CREATE OR REPLACE TEMP TABLE autocut_order (turf INT, number INT)")
    conn.executemany("INSERT INTO autocut_order VALUES (?, ?)", [(turf, i + 1) for i, turf in enumerate(path)])
    conn.execute("""
        CREATE OR REPLACE TEMP TABLE autocut_polygons AS
        SELECT p.turf, o.number, p.geom FROM autocut_polygons p JOIN autocut_order o USING (turf)
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
            SELECT uuid(), ?::UUID, ?::UUID, ?::UUID, json(ST_AsGeoJSON(geom)), (number - 1)::INT
            FROM autocut_polygons
            """,
            [payload.campaign_id, payload.zone_id, segment_id],
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return conn.execute("SELECT count(*) FROM autocut_polygons").fetchone()[0]
