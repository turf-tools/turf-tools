"""Autocut: cut a campaign zone's segment buildings into turf drafts.

    turfDrafts.autocut (web) ─► jobs row ─► autocut_turfs
        buildings   segment ∩ zone, doors counted like the cutter's sidebar
        cut         buildings merged into turfs along walkable map neighbours,
                    trading walking against distance from the door target
        polygons    each turf's Voronoi cells, trimmed to its hull
        drafts      one per turf, replacing the scope's drafts; the cutter reloads them

`cut` is the algorithm; everything around it is plumbing that holds
still while the algorithm changes.
"""

import asyncio
from typing import Any

from pydantic import BaseModel, Field

import duckdb
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

# Meters of walking one merge may cost per unit of size improvement (see
# `cut`), and how much more a turf over the target is penalised than one
# under it. At 4, a full turf only absorbs neighbours under about a third
# of the target.
_SIZE_WEIGHT = 4.0
_OVERSHOOT_WEIGHT = 4.0

# Walking cost between neighbouring buildings with no walkable relationship
# between their blockfaces, e.g. back to back across a block's interior.
_AROUND_BLOCK_M = 150.0

# How far a turf's polygon reaches past its outermost buildings, then the
# wider margins tried when that trim would split it, and how much detail
# its edges keep. Ground meters.
_HULL_MARGIN_M = 10.0
_RETRY_MARGINS_M = (50.0, 100.0)
_SIMPLIFY_M = 10.0

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
    linked to the buildings whose Voronoi cells touch its own, at the cost
    of walking between them: free along one blockface, the crossing cost
    from `blockface_relationships` between two, or a walk around the block
    when their blockfaces don't meet. Because links only join map
    neighbours, every turf is one connected region of cells.

    Two turfs merge when that brings them closer to the door target by
    more than it costs to walk the link joining them. Distance from the
    target is scored as (doors − target)² / target, weighted by
    `_OVERSHOOT_WEIGHT` past the target and scaled to meters by
    `_SIZE_WEIGHT`, so there's no hard cap or floor: small turfs merge
    freely, full ones mostly stop.
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
        WITH touching AS (
            SELECT a.site AS a, b.site AS b
            FROM autocut_cells a JOIN autocut_cells b
              ON a.site < b.site AND ST_Intersects(a.geom, b.geom)
             AND ST_Dimension(ST_Intersection(a.geom, b.geom)) = 1
        ),
        -- Buildings at one spot are neighbours too.
        neighbours AS (
            SELECT x.unit_id AS u, y.unit_id AS v, x.blockface_id AS bu, y.blockface_id AS bv, true AS same_site
            FROM autocut_units x JOIN autocut_units y ON x.site = y.site AND x.unit_id < y.unit_id
            UNION ALL
            SELECT x.unit_id, y.unit_id, x.blockface_id, y.blockface_id, false
            FROM touching t JOIN autocut_units x ON x.site = t.a JOIN autocut_units y ON y.site = t.b
        ),
        rel AS (
            SELECT blockface_id_a AS a, blockface_id_b AS b, min(crossing_cost_m) AS w
            FROM {_RELATIONSHIPS}
            WHERE blockface_id_a IN (SELECT blockface_id FROM autocut_units)
              AND blockface_id_b IN (SELECT blockface_id FROM autocut_units)
            GROUP BY ALL
        ),
        pairs AS (
            SELECT n.u, n.v,
                   CASE WHEN n.same_site OR n.bu = n.bv THEN 0.0 ELSE coalesce(r.w, {_AROUND_BLOCK_M}) END AS w
            FROM neighbours n
            LEFT JOIN rel r ON r.a = least(n.bu, n.bv) AND r.b = greatest(n.bu, n.bv)
        )
        SELECT u, v, w FROM pairs UNION ALL SELECT v, u, w FROM pairs
    """)

    def off_target(doors: str) -> str:
        weight = f"CASE WHEN {doors} <= {door_target} THEN 1.0 ELSE {_OVERSHOOT_WEIGHT} END"
        return f"({_SIZE_WEIGHT} * {weight} * power({doors} - {door_target}, 2) / {door_target})"

    # Each round, every turf picks the neighbour whose merge gains the most,
    # and pairs that picked each other merge. The best merge overall is
    # always mutual, so every round makes progress; it stops when no merge
    # gains anything.
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
             pairs AS (
                 SELECT a.cid AS ca, b.cid AS cb, min(l.w) AS w
                 FROM autocut_links l
                 JOIN recurring.merged a ON a.unit_id = l.u
                 JOIN recurring.merged b ON b.unit_id = l.v
                 WHERE a.cid <> b.cid
                 GROUP BY ALL
             ),
             gains AS (
                 SELECT p.ca, p.cb,
                        {off_target("sa.doors")} + {off_target("sb.doors")}
                          - {off_target("(sa.doors + sb.doors)")} - p.w AS gain
                 FROM pairs p JOIN sizes sa ON sa.cid = p.ca JOIN sizes sb ON sb.cid = p.cb
             ),
             best AS (
                 SELECT ca, arg_max(cb, (gain, -least(ca, cb), -greatest(ca, cb))) AS cb
                 FROM gains WHERE gain > 0
                 GROUP BY ca
             )
             SELECT m.unit_id, b1.cb
             FROM best b1
             JOIN best b2 ON b2.ca = b1.cb AND b2.cb = b1.ca
             JOIN recurring.merged m ON m.cid = b1.ca
             WHERE b1.ca > b1.cb)
        )
        SELECT u.building_id, dense_rank() OVER (ORDER BY m.cid)::INT - 1 AS turf
        FROM autocut_units u JOIN merged m USING (unit_id)
    """)


def _build_polygons(conn: duckdb.DuckDBPyConnection) -> None:
    """One polygon per turf, in `autocut_polygons`.

    A turf is its buildings' Voronoi cells, trimmed to their convex hull
    padded a little, so it hugs its buildings instead of filling parks and
    rivers. Cells never overlap, so neither do turfs. A turf the trim would
    split (its cells connect outside the hull) retries with wider margins,
    and one still split after that is drawn in pieces. Work
    happens in Web Mercator, which stretches ground distance by
    1/cos(latitude). The cutter draws single rings, so holes are filled,
    and a turf sitting in one is absorbed by the turf around it rather
    than drawn twice.
    """

    def trim(margin_m: float) -> str:
        pad = f"ST_Buffer(h.geom, {margin_m} * scale.k, 2, 'CAP_ROUND', 'JOIN_MITRE', 2.0)"
        return f"ST_Intersection(c.geom, {pad})"

    margins = (_HULL_MARGIN_M, *_RETRY_MARGINS_M)
    retries = " ".join(f"WHEN ST_NumGeometries({trim(m)}) = 1 THEN {trim(m)}" for m in margins)
    retries += f" ELSE {trim(margins[-1])}"
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE autocut_polygons AS
        WITH scale AS (
            SELECT 1 / cos(radians(avg(latitude))) AS k FROM autocut_sites
        ),
        -- Buildings sharing a spot share one cell.
        site_turfs AS (
            SELECT u.site, min(t.turf) AS turf
            FROM autocut_units u JOIN autocut_turfs t USING (building_id)
            GROUP BY u.site
        ),
        turf_cells AS (
            SELECT st.turf, ST_Union_Agg(c.geom) AS geom
            FROM site_turfs st JOIN autocut_cells c USING (site)
            GROUP BY st.turf
        ),
        hulls AS (
            SELECT st.turf, ST_ConvexHull(ST_Collect(list(s.pt))) AS geom
            FROM site_turfs st JOIN autocut_sites s USING (site)
            GROUP BY st.turf
        ),
        clipped AS (
            SELECT c.turf, CASE {retries} END AS geom
            FROM turf_cells c JOIN hulls h USING (turf), scale
        ),
        -- Simplified together so neighbours keep sharing edges; the
        -- result comes back in input order.
        coverage AS (
            SELECT ST_CoverageSimplify(list(geom ORDER BY turf), {_SIMPLIFY_M} * any_value(scale.k)) AS geom,
                   list(turf ORDER BY turf) AS turfs
            FROM clipped, scale
        ),
        simplified AS (
            SELECT turfs[d.path[1]] AS turf, d.geom
            FROM coverage, unnest(ST_Dump(coverage.geom)) AS u(d)
        ),
        pieces AS (
            SELECT turf, unnest(ST_Dump(geom), recursive := true) FROM simplified
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
