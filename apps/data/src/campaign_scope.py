"""What a campaign cuts: its segment's criteria and, for zoned campaigns,
the zone whose keys narrow it. Shared by publish and autocut, which both
work one `(campaign, zone)` at a time; `zone_id` is None for zoneless
campaigns, which span the whole segment."""

import json
from dataclasses import dataclass

import duckdb
from src.dsl.criteria import Criteria, KeyFilter
from src.duckdb import OPERATIONAL_PG_ALIAS


class ScopeError(Exception):
    """The campaign can't be cut as asked. `status` is the HTTP status an
    endpoint answers with."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class CampaignScope:
    campaign_id: str
    segment_id: str
    script_id: str | None
    criteria: Criteria
    zone_group_id: str | None
    key_group: str | None
    zone_id: str | None
    zone_name: str | None
    keys: list[str]

    @property
    def key_filter(self) -> KeyFilter | None:
        """The zone's keys; None for zoneless campaigns."""
        return KeyFilter(keyGroup=self.key_group, keys=self.keys) if self.key_group is not None else None


def load_campaign_scope(conn: duckdb.DuckDBPyConnection, campaign_id: str, zone_id: str | None) -> CampaignScope:
    """Resolve the campaign, its segment, and the zone in one query through
    the attached operational Postgres.

    Zone joins are LEFT so zoneless campaigns still produce a row. A zone
    must be given exactly when the campaign has a zone group.
    """
    row = conn.execute(
        f"""
        SELECT
            s.segment_id::VARCHAR,
            c.script_id::VARCHAR,
            s.criteria::VARCHAR,
            c.zone_group_id::VARCHAR,
            zg.key_group,
            z.zone_id::VARCHAR,
            z.name,
            z.keys::VARCHAR
        FROM {OPERATIONAL_PG_ALIAS}.app.campaigns c
        LEFT JOIN {OPERATIONAL_PG_ALIAS}.app.segments s ON s.segment_id = c.segment_id
        LEFT JOIN {OPERATIONAL_PG_ALIAS}.app.zone_groups zg ON zg.zone_group_id = c.zone_group_id
        LEFT JOIN {OPERATIONAL_PG_ALIAS}.app.zones z
            ON z.zone_id = ?::UUID AND z.zone_group_id = c.zone_group_id
        WHERE c.campaign_id = ?::UUID
        """,
        [zone_id, campaign_id],
    ).fetchone()
    if row is None:
        raise ScopeError("Campaign not found.", 404)
    segment_id, script_id, criteria_json, zone_group_id, key_group, found_zone_id, zone_name, keys_json = row

    if segment_id is None:
        raise ScopeError("Campaign has no segment bound.", 400)
    if (zone_id is not None) != (zone_group_id is not None):
        raise ScopeError("zoneId presence must match campaign.zoneGroupId presence.", 400)
    if zone_id is not None and found_zone_id is None:
        raise ScopeError("Zone not found in campaign's zone group.", 404)

    keys = json.loads(keys_json) if keys_json else []
    if not isinstance(keys, list):
        raise ScopeError("Zone.keys is not a JSON array.", 500)

    return CampaignScope(
        campaign_id=campaign_id,
        segment_id=segment_id,
        script_id=script_id,
        criteria=Criteria.model_validate(json.loads(criteria_json) if criteria_json else {}),
        zone_group_id=zone_group_id,
        key_group=key_group,
        zone_id=found_zone_id,
        zone_name=zone_name,
        keys=[str(k) for k in keys],
    )
