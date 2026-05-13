import { ORPCError } from "@orpc/server";
import { and, asc, eq, sql } from "@field-tools/db";
import { campaigns, segments, turfDrafts, turfs, zones } from "@field-tools/db/schema";
import { z } from "zod";
import { DataServiceError, dataPostJson } from "~/lib/server/data-proxy";
import { webMut as mut, webPub as pub } from "../context";

// Admin-scoped turf list: all turfs within the current user's org,
// optionally filtered by campaign. The `segments` and `zones` joins
// are LEFT joins because a turf can outlive its source segment or
// zone (forever-snapshot policy); the row stays in the list with the
// name missing rather than disappearing.
export const listForOrg = pub
  .input(z.object({ campaignId: z.string().uuid().optional() }).optional())
  .handler(async ({ context, input }) => {
    const orgFilter = eq(campaigns.organizationId, context.organizationId);
    const where = input?.campaignId
      ? and(orgFilter, eq(turfs.campaignId, input.campaignId))
      : orgFilter;
    const rows = await context.db
      .select({
        turfId: turfs.turfId,
        name: turfs.name,
        turfCode: turfs.turfCode,
        doorCount: turfs.doorCount,
        personCount: turfs.personCount,
        campaignId: turfs.campaignId,
        campaignName: campaigns.name,
        segmentId: turfs.segmentId,
        segmentName: segments.name,
        zoneId: turfs.zoneId,
        zoneName: zones.name,
        createdAt: turfs.createdAt,
      })
      .from(turfs)
      .innerJoin(campaigns, eq(turfs.campaignId, campaigns.campaignId))
      .leftJoin(segments, eq(turfs.segmentId, segments.segmentId))
      .leftJoin(zones, eq(turfs.zoneId, zones.zoneId))
      .where(where)
      .orderBy(asc(turfs.createdAt));
    return rows;
  });

// Total published-turf count for a campaign. Used by the campaign delete
// dialog to refuse deletion when turfs exist.
export const countForCampaign = pub
  .input(z.object({ campaignId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select({ count: sql<number>`count(*)::int` })
      .from(turfs)
      .where(eq(turfs.campaignId, input.campaignId));
    return { count: rows[0]?.count ?? 0 };
  });

// Per-zone turf counts for a campaign — drafts (work-in-progress in the
// cutter) and published (rows in `turfs`). Drives the campaign editor's
// at-a-glance progress indicators.
export const statsForCampaign = pub
  .input(z.object({ campaignId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const draftRows = await context.db
      .select({ zoneId: turfDrafts.zoneId, count: sql<number>`count(*)::int` })
      .from(turfDrafts)
      .where(eq(turfDrafts.campaignId, input.campaignId))
      .groupBy(turfDrafts.zoneId);
    const turfRows = await context.db
      .select({ zoneId: turfs.zoneId, count: sql<number>`count(*)::int` })
      .from(turfs)
      .where(eq(turfs.campaignId, input.campaignId))
      .groupBy(turfs.zoneId);
    const stats: Record<string, { drafts: number; published: number }> = {};
    for (const r of draftRows) stats[r.zoneId] = { drafts: r.count, published: 0 };
    for (const r of turfRows) {
      const cur = stats[r.zoneId] ?? { drafts: 0, published: 0 };
      cur.published = r.count;
      stats[r.zoneId] = cur;
    }
    return stats;
  });

// Publish drafts for a `(campaign, zone)` as immutable turfs. The
// data service does the spatial join + JSON construction; the web
// RPC just looks up the org slug and forwards the call.
type PublishResult = {
  created: Array<{ turfId: string; name: string; turfCode: string }>;
  summary: { turfCount: number; doorCount: number; personCount: number };
};

export const publish = mut
  .input(
    z.object({
      campaignId: z.string().uuid(),
      zoneId: z.string().uuid(),
    }),
  )
  .handler(async ({ context, input }): Promise<PublishResult> => {
    try {
      return await dataPostJson<PublishResult>("/turfs/publish", {
        campaignId: input.campaignId,
        zoneId: input.zoneId,
        createdBy: context.user.id,
        orgSlug: context.orgSlug,
      });
    } catch (e) {
      // Surface upstream 4xx (e.g. ambiguous-assignment rejection) as a
      // proper client error with the FastAPI `detail` message, so the UI
      // shows "Buildings X, Y are inside multiple polygons" instead of a
      // sanitized "Internal server error".
      if (e instanceof DataServiceError && e.status >= 400 && e.status < 500) {
        throw new ORPCError("BAD_REQUEST", { message: e.detail });
      }
      throw e;
    }
  });
