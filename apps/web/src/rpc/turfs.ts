import { and, asc, eq, sql } from "@field-tools/db";
import {
  campaigns,
  jobs,
  segments,
  turfData,
  turfDrafts,
  turfs,
  zones,
} from "@field-tools/db/schema";
import type { TurfData } from "@field-tools/db/schema";
import { z } from "zod";
import { mut, pub } from "./context";
import { loadOrgSlug } from "./segments";

// Shared select shape for turf list/detail responses. The
// buildings/doors/persons payload lives in `turf_data` and is
// fetched separately via the dedicated RPC — list responses stay
// light by design.
const turfSelect = {
  turfId: turfs.turfId,
  name: turfs.name,
  turfCode: turfs.turfCode,
  doorCount: turfs.doorCount,
  personCount: turfs.personCount,
  geometry: turfs.geometry,
  scriptId: turfs.scriptId,
};

// Capability-based fetch — possessing the turfId is the access.
// No org check: a canvasser may belong to no org (or to a different
// one) but still hold turf ids handed out by an admin. Same model
// as a sharing link in MiniVAN / Google Docs. Brute-forcing UUIDs
// is infeasible; admins distribute ids/codes to whoever should have
// access.
export const getById = pub
  .input(z.object({ turfId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(turfSelect)
      .from(turfs)
      .where(eq(turfs.turfId, input.turfId));
    return rows[0] ?? null;
  });

// Resolve a turf by its short code (typed in or scanned from a QR).
// Capability-based — same reasoning as `getById`. Codes are
// generated server-side at publish time with enough entropy to
// resist brute-force at any reasonable rate limit.
export const getByCode = pub
  .input(z.object({ code: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(turfSelect)
      .from(turfs)
      .where(eq(turfs.turfCode, input.code));
    return rows[0] ?? null;
  });

// Admin-scoped turf list: all turfs within the current user's org,
// optionally filtered by campaign. Joins through `campaigns` since
// turfs carry a campaignId (not organizationId) directly. The
// `segments` and `zones` joins are LEFT joins because the schema
// only enforces an FK on `campaignId` — a turf can outlive its
// source segment or zone (forever-snapshot policy), and we still
// want the row to render with the name missing rather than
// disappearing from the list.
export const listForOrg = pub
  .input(z.object({ campaignId: z.string().uuid().optional() }).optional())
  .handler(async ({ context, input }) => {
    const orgFilter = eq(campaigns.organizationId, context.user.organizationId);
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

// Fetch the buildings → doors → persons payload for a single turf.
// Capability-based, same reasoning as `getById`.
export const getData = pub
  .input(z.object({ turfId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select({ data: turfData.data })
      .from(turfData)
      .where(eq(turfData.turfId, input.turfId));
    if (rows.length === 0) return null;
    return rows[0]!.data as TurfData;
  });

// Enqueue publication for all drafts in a `(campaign, zone)` scope.
// The data service resolves the campaign segment, zone keys, drafts,
// spatial join, and final inserts in the background.
export const publish = mut
  .input(
    z.object({
      campaignId: z.string().uuid(),
      zoneId: z.string().uuid(),
    }),
  )
  .handler(async ({ context, input }) => {
    const campaignRow = await context.db
      .select({
        segmentId: campaigns.segmentId,
        scriptId: campaigns.scriptId,
        zoneGroupId: campaigns.zoneGroupId,
      })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.campaignId, input.campaignId),
          eq(campaigns.organizationId, context.user.organizationId),
        ),
      );
    if (campaignRow.length === 0) throw new Error("Campaign not found");
    const { segmentId, scriptId, zoneGroupId } = campaignRow[0]!;
    if (!segmentId || !scriptId || !zoneGroupId) {
      throw new Error("Campaign must have a segment, script, and zone group bound to publish");
    }

    const zoneRow = await context.db
      .select({ zoneId: zones.zoneId })
      .from(zones)
      .where(and(eq(zones.zoneId, input.zoneId), eq(zones.zoneGroupId, zoneGroupId)));
    if (zoneRow.length === 0) {
      throw new Error("Zone not found in campaign's zone group");
    }

    const draftRows = await context.db
      .select({ count: sql<number>`count(*)::int` })
      .from(turfDrafts)
      .where(and(eq(turfDrafts.campaignId, input.campaignId), eq(turfDrafts.zoneId, input.zoneId)));
    if ((draftRows[0]?.count ?? 0) === 0) throw new Error("No drafts to publish");

    const orgSlug = await loadOrgSlug(context);
    const inserted = await context.db
      .insert(jobs)
      .values({
        task: "turf_building",
        status: "unstarted",
        payload: {
          campaignId: input.campaignId,
          zoneId: input.zoneId,
          createdBy: context.user.userId,
          orgSlug,
        },
        concurrencyKey: `publish-turfs:${input.campaignId}:${input.zoneId}`,
      })
      .returning({ jobId: jobs.jobId, status: jobs.status });

    return inserted[0]!;
  });
