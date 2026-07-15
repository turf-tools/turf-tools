"""Publish drafts for a (campaign, zone) into immutable turfs.

Single-transaction publish: reads scope (campaign, segment, zone, drafts)
from operational Postgres via DuckDB's postgres ATTACH, runs the spatial
join + per-turf JSON construction in DuckLake, INSERTs both the `turfs`
rows and their `turf_data` rows directly into Postgres. The web RPC's
`turfs.publish` is a thin caller that hands a small payload to this
function and forwards the summary back to the client. No payloads cross
the wire to web — the only response is a summary.
"""

from __future__ import annotations

import json
import logging
from contextlib import suppress
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from pydantic import BaseModel

from src.dsl.compile import criteria_to_where
from src.dsl.criteria import Criteria, KeyFilter, build_field_catalog
from src.dsl.resolve import resolve_criteria
from src.duckdb import OPERATIONAL_PG_ALIAS, attach_operational_postgres, get_connection
from src.settings import get_settings
from src.tables import resolve, resolve_version

if TYPE_CHECKING:
    import duckdb

logger = logging.getLogger("uvicorn")


class PublishTurfsRequest(BaseModel):
    campaignId: str  # noqa: N815
    # `null` ⇒ zoneless campaign: drafts are scoped only by campaign and
    # the publish reads the full segment (no key filter).
    zoneId: str | None  # noqa: N815
    createdBy: str  # noqa: N815
    orgSlug: str  # noqa: N815


@dataclass(frozen=True)
class _PublishScope:
    """Pre-resolved facts the publish SQL needs as parameters.

    For zoneless campaigns, ``zone_id``, ``zone_group_id``, ``key_group``
    are ``None`` and ``keys`` is empty — downstream SQL binds NULL for
    the zone columns and ``criteria_to_where`` is called without a key
    filter.
    """

    campaign_id: str
    segment_id: str
    zone_id: str | None
    zone_group_id: str | None
    script_id: str
    key_group: str | None
    keys: list[str]
    criteria: Criteria
    draft_count: int


_MAX_PUBLISH_RETRIES = 5


async def publish_turfs(req: PublishTurfsRequest) -> dict[str, Any]:
    """Run the full publish for one (campaign, zone) and return the summary.

    Replaces the older flow that round-tripped a giant JSON payload between
    data and web. With ATTACH, the spatial join's output is materialised in
    a temp table inside DuckDB and INSERTed directly into Postgres tables,
    avoiding the JSON marshal entirely.
    """
    settings = get_settings()
    # Use the shared read-only connection. DuckLake is attached READ_ONLY,
    # which is fine because the publish only *reads* DuckLake (filtered
    # persons + buildings); it *writes* through the operational Postgres
    # ATTACH, which isn't read-only. Going through this connection avoids
    # the local-dev DuckLake file-lock conflict (DuckDB allows only one
    # connection per process to attach a local DuckLake file at a time)
    # and matches how the rest of the read endpoints (count, sample, etc.)
    # already operate. The cached connection MUST NOT be closed.
    conn = get_connection(settings, read_only=True)

    try:
        attach_operational_postgres(conn, settings)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    version = resolve_version(conn, settings, req.orgSlug)
    schema = version.schema
    catalog = build_field_catalog(version.manifest)
    scope = _load_publish_scope(conn, req)
    criteria = resolve_criteria(scope.criteria, conn, settings, req.orgSlug)
    where_params: list = []
    # Zoned: scope to the zone's keys. Zoneless: no key filter — publish
    # spans the whole segment.
    key_filter = KeyFilter(keyGroup=scope.key_group, keys=scope.keys) if scope.key_group is not None else None
    where_sql = criteria_to_where(catalog, criteria, key_filter, where_params)
    _check_no_ambiguous_assignments(conn, req, schema, where_sql, where_params)

    # Retry budget exists only to swallow the rare turf_code collision
    # against the partial unique index on active turfs. Each attempt
    # regenerates random codes inside the temp table, so a fresh draw
    # breaks any unlucky duplicate.
    for attempt in range(_MAX_PUBLISH_RETRIES):
        try:
            conn.execute("BEGIN TRANSACTION")
            conn.execute(
                _build_publish_temp_table_sql(schema, where_sql),
                [
                    req.campaignId,
                    req.zoneId,
                    *where_params,
                    scope.campaign_id,
                    scope.segment_id,
                    scope.zone_id,
                    scope.zone_group_id,
                    scope.script_id,
                    req.createdBy,
                ],
            )
            conn.execute(_insert_turfs_sql())
            conn.execute(_insert_turf_data_sql())
            conn.execute("COMMIT")
            break
        except Exception as exc:
            with suppress(Exception):
                conn.execute("ROLLBACK")
            if _is_turf_code_collision(exc) and attempt < _MAX_PUBLISH_RETRIES - 1:
                logger.warning(
                    "publish_turfs: turf_code collision (attempt %d/%d), retrying",
                    attempt + 1,
                    _MAX_PUBLISH_RETRIES,
                )
                continue
            raise

    return _publish_summary(conn)


def _is_turf_code_collision(exc: BaseException) -> bool:
    """Detect a unique-violation against the active-turf-code index. DuckDB
    surfaces Postgres errors as opaque exceptions; we string-match the
    message because no structured error code is exposed."""
    msg = str(exc).lower()
    return "duplicate" in msg and "turf_code" in msg


def _check_no_ambiguous_assignments(
    conn: duckdb.DuckDBPyConnection,
    req: PublishTurfsRequest,
    schema: str,
    where_sql: str,
    where_params: list[Any],
) -> None:
    """Reject publishes where any one building is contained by more than one
    draft polygon.

    Polygons that overlap geographically aren't a problem on their own —
    only the *assignment ambiguity* of "which polygon does this building
    belong to?" is. A building inside zero or one polygons is fine
    (zero → dropped, one → assigned). A building inside ≥2 polygons would
    silently get whichever polygon the SQL's ``MIN(idx)`` picks, hiding
    the conflict. Failing here forces the user to redraw the cuts so each
    matched building has exactly one home.
    """
    persons_table = resolve("{persons_geocoded}", schema)
    buildings_table = resolve("{buildings_geocoded}", schema)
    # `IS NOT DISTINCT FROM` matches null-to-null, so the same predicate
    # works for zoned (zoneId is a UUID) and zoneless (zoneId is NULL)
    # publishes — no SQL branching needed.
    sql = f"""
    WITH drafts AS (
        SELECT
            row_number() OVER (ORDER BY d.sort_order, d.turf_draft_id) - 1 AS idx,
            ST_GeomFromGeoJSON(d.geometry::VARCHAR) AS geom
        FROM {OPERATIONAL_PG_ALIAS}.public.turf_drafts d
        WHERE d.campaign_id = ?::UUID AND d.zone_id IS NOT DISTINCT FROM ?::UUID
    ),
    matched_buildings AS (
        SELECT DISTINCT b.building_id, b.longitude, b.latitude
        FROM (SELECT DISTINCT building_id FROM {persons_table} {where_sql}) p
        JOIN {buildings_table} b ON b.building_id = p.building_id
    ),
    candidate_assignments AS (
        SELECT mb.building_id, d.idx
        FROM matched_buildings mb
        JOIN drafts d ON ST_Contains(d.geom, ST_Point(mb.longitude, mb.latitude))
    )
    SELECT count(*)::INT
    FROM (
        SELECT building_id
        FROM candidate_assignments
        GROUP BY building_id
        HAVING count(*) > 1
    ) ambiguous;
    """
    row = conn.execute(sql, [req.campaignId, req.zoneId, *where_params]).fetchone()
    ambiguous_count = int(row[0]) if row else 0
    if ambiguous_count > 0:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{ambiguous_count} building{'s' if ambiguous_count > 1 else ''} "
                f"fall{'s' if ambiguous_count == 1 else ''} inside more than one turf."
                " Adjust the turfs so that each building belongs to exactly "
                "one turf before publishing."
            ),
        )


def _load_publish_scope(conn: duckdb.DuckDBPyConnection, req: PublishTurfsRequest) -> _PublishScope:
    """Resolve the campaign + segment + (optional) zone + draft count in
    one SQL hit through the attached Postgres.

    Zone joins are LEFT so zoneless campaigns (``req.zoneId is None``
    AND ``campaigns.zone_group_id IS NULL``) still produce a row with
    nulls in the zone columns. ``IS NOT DISTINCT FROM`` matches the
    draft-count subquery for both zoned (zoneId UUID) and zoneless
    (zoneId NULL) callers.

    Raises 4xx for the various "not configured to publish" cases.
    """
    row = conn.execute(
        f"""
        SELECT
            c.campaign_id::VARCHAR AS campaign_id,
            c.segment_id::VARCHAR AS segment_id,
            c.script_id::VARCHAR AS script_id,
            c.zone_group_id::VARCHAR AS zone_group_id,
            s.criteria::VARCHAR AS criteria_json,
            zg.key_group,
            z.zone_id::VARCHAR AS zone_id,
            z.keys::VARCHAR AS keys_json,
            (
                SELECT count(*)::INT FROM {OPERATIONAL_PG_ALIAS}.public.turf_drafts d
                WHERE d.campaign_id = c.campaign_id
                  AND d.zone_id IS NOT DISTINCT FROM ?::UUID
            ) AS draft_count
        FROM {OPERATIONAL_PG_ALIAS}.public.campaigns c
        JOIN {OPERATIONAL_PG_ALIAS}.public.segments s ON s.segment_id = c.segment_id
        LEFT JOIN {OPERATIONAL_PG_ALIAS}.public.zone_groups zg
            ON zg.zone_group_id = c.zone_group_id
        LEFT JOIN {OPERATIONAL_PG_ALIAS}.public.zones z
            ON z.zone_id = ?::UUID
            AND z.zone_group_id = c.zone_group_id
        WHERE c.campaign_id = ?::UUID
        """,
        [req.zoneId, req.zoneId, req.campaignId],
    ).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Campaign not found.")

    (
        campaign_id,
        segment_id,
        script_id,
        campaign_zone_group_id,
        criteria_json,
        key_group,
        zone_id,
        keys_json,
        draft_count,
    ) = row

    if not segment_id or not script_id:
        raise HTTPException(
            status_code=400,
            detail="Campaign must have a segment and script bound to publish.",
        )
    # Valid shapes: zoned (both zoneId and zoneGroupId present) or
    # zoneless (both absent). Anything else is a caller bug.
    expects_zone = req.zoneId is not None
    has_zone_group = campaign_zone_group_id is not None
    if expects_zone != has_zone_group:
        raise HTTPException(
            status_code=400,
            detail="zoneId presence must match campaign.zoneGroupId presence.",
        )
    if expects_zone and not zone_id:
        raise HTTPException(status_code=404, detail="Zone not found in campaign's zone group.")
    if draft_count == 0:
        raise HTTPException(status_code=400, detail="No drafts to publish.")

    criteria = Criteria.model_validate(json.loads(criteria_json) if criteria_json else {})
    keys = json.loads(keys_json) if keys_json else []
    if not isinstance(keys, list):
        raise HTTPException(status_code=500, detail="Zone.keys is not a JSON array.")

    return _PublishScope(
        campaign_id=campaign_id,
        segment_id=segment_id,
        zone_id=zone_id,
        zone_group_id=campaign_zone_group_id,
        script_id=script_id,
        key_group=key_group,
        keys=[str(k) for k in keys],
        criteria=criteria,
        draft_count=int(draft_count),
    )


def _build_publish_temp_table_sql(schema: str, where_sql: str) -> str:
    """Build the per-draft payload in a DuckDB TEMP TABLE.

    One row per draft, with: a generated turf_id, a generated 8-digit
    turf_code, all the metadata columns, and the full per-turf
    `turf_data.data` JSON blob (turfId/turfCode/name/geometry/buildings).
    The two INSERTs that follow read from this table, so the turf_id is
    consistent across both target tables without RETURNING.

    Parameter order (positional `?`):
      $1 campaign_id (UUID)         — for the drafts CTE
      $2 zone_id (UUID)             — for the drafts CTE
      $3..    where_params          — variable, from to_where
      then:
      campaign_id, segment_id, zone_id, zone_group_id, script_id, created_by
      (all as UUID strings, in `generated`)
    """
    persons_table = resolve("{persons_geocoded}", schema)
    buildings_table = resolve("{buildings_geocoded}", schema)
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
        FROM {OPERATIONAL_PG_ALIAS}.public.turf_drafts d
        WHERE d.campaign_id = ?::UUID
          AND d.zone_id IS NOT DISTINCT FROM ?::UUID
    ),
    filtered_persons AS (
        SELECT * FROM {persons_table} {where_sql}
    ),
    assigned AS (
        -- Each building goes into its (unique) containing polygon. The
        -- ambiguity pre-check upstream guarantees no building is in
        -- more than one polygon, so MIN(idx) is just "the one match."
        -- Buildings outside every polygon are silently dropped.
        SELECT
            assignment.polygon_idx,
            p.external_id, p.first_name, p.last_name,
            p.address_line_2 AS unit,
            p.enrollment, p.gender, p.date_of_birth,
            p.registration_date, p.registration_status, p.last_voted_date,
            p.county_code, p.precinct, p.assembly_district,
            p.senate_district, p.congressional_district,
            p.voting_history,
            p.building_id, p.door_id,
            b.latitude, b.longitude,
            b.address_line_1 AS street, b.city, b.state, b.zip5 AS zip
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
            polygon_idx, building_id, door_id, unit,
            any_value(latitude) AS latitude, any_value(longitude) AS longitude,
            any_value(street) AS street, any_value(city) AS city,
            any_value(state) AS state, any_value(zip) AS zip,
            -- Per-person wire payload. Still a hardcoded voter-file field list —
            -- making it manifest-driven is a tracked follow-up.
            json_group_array(json_object(
                'personId', external_id,
                'firstName', first_name,
                'lastName', last_name,
                'enrollment', enrollment,
                'gender', gender,
                'dateOfBirth', date_of_birth,
                'registrationDate', registration_date,
                'registrationStatus', registration_status,
                'lastVotedDate', last_voted_date,
                'countyCode', county_code,
                'precinct', precinct,
                'assemblyDistrict', assembly_district,
                'senateDistrict', senate_district,
                'congressionalDistrict', congressional_district,
                'votingHistory', coalesce(to_json(voting_history), json('[]'))
            )) AS persons
        FROM assigned
        GROUP BY polygon_idx, building_id, door_id, unit
    ),
    building_payloads AS (
        SELECT
            polygon_idx, building_id,
            any_value(latitude) AS latitude, any_value(longitude) AS longitude,
            any_value(street) AS street, any_value(city) AS city,
            any_value(state) AS state, any_value(zip) AS zip,
            json_group_array(json_object(
                'doorId', door_id::VARCHAR,
                'unit', unit,
                'persons', json(persons)
            )) AS doors
        FROM door_payloads
        GROUP BY polygon_idx, building_id
    ),
    turf_buildings AS (
        SELECT
            polygon_idx,
            json_group_array(json_object(
                'buildingId', building_id::VARCHAR,
                'latitude', latitude,
                'longitude', longitude,
                'address', json_object(
                    'street', street, 'city', city,
                    'state', state, 'zip', zip
                ),
                'doors', json(doors)
            )) AS buildings
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
            -- 8-digit numeric turf_code. With the partial unique index
            -- (active turfs only), collisions are vanishingly rare;
            -- a unique-violation aborts the transaction and the caller
            -- retries up to `_MAX_PUBLISH_RETRIES` times.
            lpad(
                floor(random() * 100000000)::BIGINT::VARCHAR,
                8, '0'
            ) AS turf_code,
            ?::UUID AS campaign_id,
            ?::UUID AS segment_id,
            ?::UUID AS zone_id,
            ?::UUID AS zone_group_id,
            ?::UUID AS script_id,
            coalesce(d.name, 'Turf ' || (d.idx + 1)::VARCHAR) AS name,
            d.geometry_json,
            coalesce(c.door_count, 0) AS door_count,
            coalesce(c.person_count, 0) AS person_count,
            ?::UUID AS created_by,
            coalesce(tb.buildings, json('[]')) AS buildings
        FROM drafts d
        LEFT JOIN counts c ON c.polygon_idx = d.idx
        LEFT JOIN turf_buildings tb ON tb.polygon_idx = d.idx
    )
    SELECT
        turf_id, turf_code,
        campaign_id, segment_id, zone_id, zone_group_id, script_id,
        name, geometry_json,
        door_count, person_count,
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
    INSERT INTO {OPERATIONAL_PG_ALIAS}.public.turfs (
        turf_id, campaign_id, segment_id, zone_id, zone_group_id,
        script_id, name, turf_code, geometry, door_count, person_count,
        created_by
    )
    SELECT
        turf_id, campaign_id, segment_id, zone_id, zone_group_id,
        script_id, name, turf_code, json(geometry_json),
        door_count, person_count, created_by
    FROM published_turf_rows;
    """


def _insert_turf_data_sql() -> str:
    return f"""
    INSERT INTO {OPERATIONAL_PG_ALIAS}.public.turf_data (turf_id, data)
    SELECT turf_id, json(data) FROM published_turf_rows;
    """


def _publish_summary(conn: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """Read the temp-table back to assemble the response. Cheap because the
    temp table is small (one row per draft, dozens at most)."""
    rows = conn.execute(
        """
        SELECT turf_id::VARCHAR, name, turf_code, door_count, person_count
        FROM published_turf_rows
        ORDER BY name
        """
    ).fetchall()
    return {
        "created": [{"turfId": r[0], "name": r[1], "turfCode": r[2]} for r in rows],
        "summary": {
            "turfCount": len(rows),
            "doorCount": sum(r[3] or 0 for r in rows),
            "personCount": sum(r[4] or 0 for r in rows),
        },
    }
