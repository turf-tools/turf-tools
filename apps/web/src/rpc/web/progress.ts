import { sql } from "@turf-tools/db";
import { dataPostJson } from "~/lib/server/data-proxy";
import { z } from "zod";
import { activeDatasetId } from "./active-dataset";
import { webPub as pub } from "../context";

// Per-turf attempted counts: persons whose *latest* result (by sequence —
// results are full snapshots, newest wins) has a non-null outcome. The
// page divides by the turf's personCount for its progress fraction.
//
// Served through a short in-process TTL cache keyed by (org, campaign):
// every lead polling one campaign shares a single aggregation, so DB cost
// is one query per campaign per TTL regardless of how many leads are
// watching. Progress moves at door-knocking speed; 15s staleness is
// invisible.
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; rows: ProgressRow[] }>();

type ProgressRow = { turfId: string; attempted: number };

type ZoneProgressRow = {
  campaignId: string;
  campaignName: string;
  zoneId: string | null;
  zoneName: string | null;
  people: number;
  doors: number;
  turfs: number;
  used: number;
  attempted: number;
};

const zoneCache = new Map<string, { at: number; rows: ZoneProgressRow[] }>();

export const forOrg = pub
  .input(z.object({ campaignId: z.string().uuid().optional() }).optional())
  .handler(async ({ context, input }): Promise<ProgressRow[]> => {
    // Active-dataset scoped like turfs.listForOrg; the dataset is part of the
    // cache key so switching datasets can't serve the old scope.
    const datasetId = await activeDatasetId(context.db, context.organizationId);
    if (!datasetId) return [];
    const key = `${context.organizationId}:${datasetId}:${input?.campaignId ?? "all"}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

    const campaignFilter = input?.campaignId ? sql`AND t.campaign_id = ${input.campaignId}` : sql``;
    const result = await context.db.execute(sql`
      SELECT turf_id, count(*)::int AS attempted FROM (
        SELECT DISTINCT ON (e.turf_id, e.person_id)
          e.turf_id,
          e.payload->>'outcome' AS outcome
        FROM app.canvass_events e
        JOIN app.turfs t ON t.turf_id = e.turf_id
        JOIN app.campaigns c ON c.campaign_id = t.campaign_id
        WHERE e.kind = 'result'
          AND e.person_id IS NOT NULL
          AND c.organization_id = ${context.organizationId}
          AND c.dataset_id = ${datasetId}
          ${campaignFilter}
        ORDER BY e.turf_id, e.person_id, e.sequence DESC
      ) latest
      WHERE outcome IS NOT NULL
      GROUP BY turf_id
    `);
    // postgres-js returns the row array directly (no `.rows` wrapper).
    const rows = (result as unknown as Array<{ turf_id: string; attempted: number }>).map((r) => ({
      turfId: r.turf_id,
      attempted: r.attempted,
    }));
    cache.set(key, { at: Date.now(), rows });
    return rows;
  });

// Per-(campaign, zone) rollup for the Progress page. All counts are
// commitment-frame: people/doors/turfs are frozen turf snapshots (what was
// cut and published), attempted is the latest-per-(campaign, person)
// reduction, and used counts turfs with at least one surviving attempt —
// a turf whose only results were cleared stays unused. Live segment
// evaluation (the intent frame) is deliberately absent here. Archived
// campaigns' rows are included — the page always scopes to one campaign,
// and a finished pass's final state is legitimate history.
export const byZone = pub
  .input(z.object({}).optional())
  .handler(async ({ context }): Promise<ZoneProgressRow[]> => {
    const datasetId = await activeDatasetId(context.db, context.organizationId);
    if (!datasetId) return [];
    const key = `${context.organizationId}:${datasetId}`;
    const hit = zoneCache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

    const result = await context.db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (t.campaign_id, e.person_id)
          t.campaign_id,
          e.turf_id,
          e.payload->>'outcome' AS outcome
        FROM app.canvass_events e
        JOIN app.turfs t ON t.turf_id = e.turf_id
        JOIN app.campaigns c ON c.campaign_id = t.campaign_id
        WHERE e.kind = 'result'
          AND e.person_id IS NOT NULL
          AND c.organization_id = ${context.organizationId}
          AND c.dataset_id = ${datasetId}
        ORDER BY t.campaign_id, e.person_id, e.sequence DESC
      ),
      attempted AS (
        SELECT campaign_id, turf_id, count(*)::int AS att
        FROM latest WHERE outcome IS NOT NULL
        GROUP BY campaign_id, turf_id
      )
      SELECT
        c.campaign_id,
        c.name AS campaign_name,
        t.zone_id,
        t.zone_name,
        coalesce(sum(t.person_count), 0)::int AS people,
        coalesce(sum(t.door_count), 0)::int AS doors,
        count(*)::int AS turfs,
        count(a.turf_id)::int AS used,
        coalesce(sum(a.att), 0)::int AS attempted
      FROM app.turfs t
      JOIN app.campaigns c ON c.campaign_id = t.campaign_id
      LEFT JOIN attempted a ON a.turf_id = t.turf_id AND a.campaign_id = t.campaign_id
      WHERE t.status = 'active'
        AND c.organization_id = ${context.organizationId}
        AND c.dataset_id = ${datasetId}
      GROUP BY c.campaign_id, c.name, t.zone_id, t.zone_name
      ORDER BY c.name, t.zone_name NULLS FIRST
    `);
    const rows = (
      result as unknown as Array<{
        campaign_id: string;
        campaign_name: string;
        zone_id: string | null;
        zone_name: string | null;
        people: number;
        doors: number;
        turfs: number;
        used: number;
        attempted: number;
      }>
    ).map((r) => ({
      campaignId: r.campaign_id,
      campaignName: r.campaign_name,
      zoneId: r.zone_id,
      zoneName: r.zone_name,
      people: r.people,
      doors: r.doors,
      turfs: r.turfs,
      used: r.used,
      attempted: r.attempted,
    }));
    zoneCache.set(key, { at: Date.now(), rows });
    return rows;
  });

export type ProgressTargetsRow = {
  campaignId: string;
  zoneId: string;
  zoneName: string | null;
  people: number;
  doors: number;
};

// Live intent-frame counts (campaign segment ∩ zone, current dataset) —
// computed in apps/data; the frozen cut columns stay Postgres-only.
export const targets = pub
  .input(z.object({}).optional())
  .handler(async ({ context }): Promise<{ rows: ProgressTargetsRow[] }> => {
    return dataPostJson<{ rows: ProgressTargetsRow[] }>("/progress/targets", {
      orgSlug: context.orgSlug,
    });
  });
