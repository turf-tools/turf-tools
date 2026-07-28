import { sql } from "@turf-tools/db";
import { z } from "zod";
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

export const forOrg = pub
  .input(z.object({ campaignId: z.string().uuid().optional() }).optional())
  .handler(async ({ context, input }): Promise<ProgressRow[]> => {
    const key = `${context.organizationId}:${input?.campaignId ?? "all"}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

    const campaignFilter = input?.campaignId ? sql`AND t.campaign_id = ${input.campaignId}` : sql``;
    const result = await context.db.execute(sql`
      SELECT turf_id, count(*)::int AS attempted FROM (
        SELECT DISTINCT ON (e.turf_id, e.person_id)
          e.turf_id,
          e.payload->>'outcome' AS outcome
        FROM canvass_events e
        JOIN turfs t ON t.turf_id = e.turf_id
        JOIN campaigns c ON c.campaign_id = t.campaign_id
        WHERE e.kind = 'result'
          AND e.person_id IS NOT NULL
          AND c.organization_id = ${context.organizationId}
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
