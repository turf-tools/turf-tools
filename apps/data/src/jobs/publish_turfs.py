"""Publish turf drafts into immutable turf rows."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

from src.abstract_tables import resolve
from src.dsl.compile import to_where
from src.dsl.criteria import Criteria, KeyFilter
from src.duckdb import get_connection
from src.job_runner import JobContext, job
from src.settings import get_settings

if TYPE_CHECKING:
    import duckdb

settings = get_settings()

OPERATIONAL_DB_ALIAS = "operational_pg"


class PublishTurfsRequest(BaseModel):
    campaignId: str  # noqa: N815
    zoneId: str  # noqa: N815
    createdBy: str  # noqa: N815
    orgSlug: str  # noqa: N815


@job(task="turf_building")
async def turf_building(req: PublishTurfsRequest, ctx: JobContext) -> dict[str, Any]:
    await ctx.message("Started turf publish.", campaignId=req.campaignId, zoneId=req.zoneId, orgSlug=req.orgSlug)
    result = await publish_turfs(req)
    await ctx.message(
        "Completed turf publish.",
        turfCount=result["summary"]["turfCount"],
        doorCount=result["summary"]["doorCount"],
        personCount=result["summary"]["personCount"],
    )
    return result


async def publish_turfs(req: PublishTurfsRequest) -> dict[str, Any]:
    scope = await _load_publish_scope(req)
    where_sql, where_params = to_where(scope.criteria, KeyFilter(keyGroup=scope.key_group, keys=scope.keys))
    create_rows_sql = _publish_rows_sql(where_sql, org_slug=req.orgSlug, scope=scope)

    conn = get_connection(settings)
    try:
        _attach_operational_postgres(conn)
        try:
            conn.execute("BEGIN TRANSACTION")
            conn.execute(create_rows_sql, [req.campaignId, req.zoneId, *where_params])
            conn.execute(_insert_turfs_sql())
            conn.execute(_insert_turf_data_sql())
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        return _publish_result(conn)
    finally:
        conn.close()


class _PublishScope(BaseModel):
    criteria: Criteria
    key_group: str
    keys: list[str]
    campaign_id: str
    segment_id: str
    zone_id: str
    zone_group_id: str
    script_id: str
    created_by: str


def _attach_operational_postgres(conn: duckdb.DuckDBPyConnection) -> None:
    conn.install_extension("postgres")
    conn.load_extension("postgres")
    database_url = settings.database_url.replace("'", "''")
    conn.execute(f"ATTACH IF NOT EXISTS '{database_url}' AS {OPERATIONAL_DB_ALIAS} (TYPE postgres)")


async def _load_publish_scope(req: PublishTurfsRequest) -> _PublishScope:
    rows = await _run_operational_query(
        """
        SELECT
            c.campaign_id::TEXT AS campaign_id,
            c.segment_id::TEXT AS segment_id,
            c.script_id::TEXT AS script_id,
            c.zone_group_id::TEXT AS zone_group_id,
            s.criteria AS criteria,
            zg.key_group AS key_group,
            z.zone_id::TEXT AS zone_id,
            z.keys AS keys,
            (
                SELECT count(*)::INT
                FROM turf_drafts d
                WHERE d.campaign_id = c.campaign_id
                  AND d.zone_id = z.zone_id
            ) AS draft_count
        FROM campaigns c
        JOIN segments s ON s.segment_id = c.segment_id
        JOIN zone_groups zg ON zg.zone_group_id = c.zone_group_id
        JOIN zones z
            ON z.zone_id = {}::UUID
           AND z.zone_group_id = c.zone_group_id
        WHERE c.campaign_id = {}::UUID
        """,
        req.zoneId,
        req.campaignId,
    )
    if not rows:
        raise ValueError("Campaign, segment, zone group, or zone could not be resolved for turf publishing.")

    row = dict(rows[0])
    segment_id = row["segment_id"]
    script_id = row["script_id"]
    zone_group_id = row["zone_group_id"]
    if segment_id is None or script_id is None or zone_group_id is None:
        raise ValueError("Campaign must have a segment, script, and zone group bound to publish.")

    criteria = Criteria.model_validate(_json_value(row["criteria"]) or {})
    keys = _json_value(row["keys"]) or []
    if not isinstance(keys, list):
        raise ValueError("Zone keys must be a JSON array.")

    if row["draft_count"] == 0:
        raise ValueError("No drafts to publish.")

    return _PublishScope(
        criteria=criteria,
        key_group=row["key_group"],
        keys=[str(key) for key in keys],
        campaign_id=row["campaign_id"],
        segment_id=segment_id,
        zone_id=row["zone_id"],
        zone_group_id=zone_group_id,
        script_id=script_id,
        created_by=req.createdBy,
    )


async def _run_operational_query(template: str, *args: Any) -> list[Any]:
    from piccolo.engine import engine_finder
    from piccolo.querystring import QueryString

    engine = engine_finder()
    if engine is None:
        raise RuntimeError("Piccolo engine is not configured.")
    return await engine.run_querystring(QueryString(template, *args))


def _json_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        return json.loads(value)
    return value


def _publish_rows_sql(where_sql: str, *, org_slug: str, scope: _PublishScope) -> str:
    persons_table = resolve("{persons_geocoded}", slug=org_slug)
    buildings_table = resolve("{buildings_geocoded}", slug=org_slug)
    return f"""
    CREATE OR REPLACE TEMP TABLE published_turf_rows AS
    WITH drafts AS (
        SELECT
            row_number() OVER (ORDER BY d.sort_order, d.turf_draft_id) - 1 AS idx,
            d.turf_draft_id,
            d.name,
            d.sort_order,
            d.geometry::VARCHAR AS geometry_json,
            ST_GeomFromGeoJSON(d.geometry::VARCHAR) AS geom
        FROM {OPERATIONAL_DB_ALIAS}.public.turf_drafts d
        WHERE d.campaign_id = ?::UUID
          AND d.zone_id = ?::UUID
    ),
    filtered_persons AS (
        SELECT *
        FROM {persons_table} {where_sql}
    ),
    assigned AS (
        SELECT
            assignment.polygon_idx,
            p.external_id,
            p.first_name,
            p.last_name,
            p.address_line_2 AS unit,
            p.other_properties,
            p.building_id,
            p.door_id,
            b.latitude,
            b.longitude,
            b.address_line_1 AS street,
            b.city,
            b.state,
            b.zip5 AS zip
        FROM filtered_persons p
        JOIN {buildings_table} b ON b.building_id = p.building_id
        JOIN LATERAL (
            SELECT MIN(d.idx) AS polygon_idx
            FROM drafts d
            WHERE ST_Contains(d.geom, ST_Point(b.longitude, b.latitude))
        ) assignment ON assignment.polygon_idx IS NOT NULL
    ),
    door_payloads AS (
        SELECT
            polygon_idx,
            building_id,
            door_id,
            unit,
            any_value(latitude) AS latitude,
            any_value(longitude) AS longitude,
            any_value(street) AS street,
            any_value(city) AS city,
            any_value(state) AS state,
            any_value(zip) AS zip,
            json_group_array(
                json_object(
                    'personId', external_id,
                    'firstName', first_name,
                    'lastName', last_name,
                    'otherProperties', coalesce(json(other_properties::VARCHAR), json('{{}}'))
                )
            ) AS persons
        FROM assigned
        GROUP BY polygon_idx, building_id, door_id, unit
    ),
    building_payloads AS (
        SELECT
            polygon_idx,
            building_id,
            any_value(latitude) AS latitude,
            any_value(longitude) AS longitude,
            any_value(street) AS street,
            any_value(city) AS city,
            any_value(state) AS state,
            any_value(zip) AS zip,
            json_group_array(
                json_object(
                    'doorId', door_id::VARCHAR,
                    'unit', unit,
                    'persons', json(persons)
                )
            ) AS doors
        FROM door_payloads
        GROUP BY polygon_idx, building_id
    ),
    turf_buildings AS (
        SELECT
            polygon_idx,
            json_group_array(
                json_object(
                    'buildingId', building_id::VARCHAR,
                    'latitude', latitude,
                    'longitude', longitude,
                    'address', json_object(
                        'street', street,
                        'city', city,
                        'state', state,
                        'zip', zip
                    ),
                    'doors', json(doors)
                )
            ) AS buildings
        FROM building_payloads
        GROUP BY polygon_idx
    ),
    counts AS (
        SELECT
            polygon_idx,
            count(DISTINCT door_id)::INT AS door_count,
            count(*)::INT AS person_count
        FROM assigned
        GROUP BY polygon_idx
    ),
    generated AS (
        SELECT
            uuid() AS turf_id,
            lpad(floor(random() * 100000000)::BIGINT::VARCHAR, 8, '0') AS turf_code,
            '{scope.campaign_id}'::UUID AS campaign_id,
            '{scope.segment_id}'::UUID AS segment_id,
            '{scope.zone_id}'::UUID AS zone_id,
            '{scope.zone_group_id}'::UUID AS zone_group_id,
            '{scope.script_id}'::UUID AS script_id,
            coalesce(d.name, 'Turf ' || (d.idx + 1)::VARCHAR) AS name,
            d.geometry_json,
            coalesce(c.door_count, 0) AS door_count,
            coalesce(c.person_count, 0) AS person_count,
            '{scope.created_by}'::UUID AS created_by,
            coalesce(tb.buildings, json('[]')) AS buildings
        FROM drafts d
        LEFT JOIN counts c ON c.polygon_idx = d.idx
        LEFT JOIN turf_buildings tb ON tb.polygon_idx = d.idx
    )
    SELECT
        turf_id,
        turf_code,
        campaign_id,
        segment_id,
        zone_id,
        zone_group_id,
        script_id,
        name,
        geometry_json,
        door_count,
        person_count,
        created_by,
        json_object(
            'turfId', turf_id::VARCHAR,
            'turfCode', turf_code,
            'name', name,
            'geometry', json(geometry_json),
            'buildings', json(buildings)
        ) AS data
    FROM generated;

    """


def _insert_turfs_sql() -> str:
    return f"""
    INSERT INTO {OPERATIONAL_DB_ALIAS}.public.turfs (
        turf_id,
        campaign_id,
        segment_id,
        zone_id,
        zone_group_id,
        script_id,
        name,
        turf_code,
        geometry,
        door_count,
        person_count,
        created_by
    )
    SELECT
        turf_id,
        campaign_id,
        segment_id,
        zone_id,
        zone_group_id,
        script_id,
        name,
        turf_code,
        json(geometry_json),
        door_count,
        person_count,
        created_by
    FROM published_turf_rows;
    """


def _insert_turf_data_sql() -> str:
    return f"""
    INSERT INTO {OPERATIONAL_DB_ALIAS}.public.turf_data (turf_id, data)
    SELECT turf_id, json(data)
    FROM published_turf_rows;
    """


def _publish_result(conn: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT turf_id::VARCHAR, name, turf_code, door_count, person_count
        FROM published_turf_rows
        ORDER BY name
        """
    ).fetchall()
    return {
        "created": [{"turfId": row[0], "name": row[1], "turfCode": row[2]} for row in rows],
        "summary": {
            "turfCount": len(rows),
            "doorCount": sum(row[3] or 0 for row in rows),
            "personCount": sum(row[4] or 0 for row in rows),
        },
    }
