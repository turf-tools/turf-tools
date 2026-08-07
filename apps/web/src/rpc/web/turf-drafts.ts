import { ORPCError } from "@orpc/server";
import { and, asc, eq, isNull } from "@turf-tools/db";
import { campaigns, turfDrafts } from "@turf-tools/db/schema";
import { z } from "zod";
import { webPub as pub } from "../context";

// Drafts are scoped to `(campaignId, zoneId)`, where `zoneId` is null
// for zoneless campaigns (cut against the full segment). Drizzle's
// `eq(col, null)` resolves to `col = NULL` which is never true, so we
// match the SQL semantics explicitly.
const zoneIdMatch = (zid: string | null) =>
  zid === null ? isNull(turfDrafts.zoneId) : eq(turfDrafts.zoneId, zid);

const nullableUuid = z.string().uuid().nullable();

// GeoJSON Polygon validator. We don't enforce ring-closure here —
// the cutter naturally produces closed rings, and the publish path
// is the only consumer that cares about exact closure semantics.
const polygonSchema = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(z.array(z.number()))).min(1),
});

// List all drafts for a `(campaignId, zoneId)` scope. Org-checked
// via the parent campaign — drafts don't carry their own org id.
export const list = pub
  .input(
    z.object({
      campaignId: z.string().uuid(),
      zoneId: nullableUuid,
    }),
  )
  .handler(async ({ context, input }) => {
    // Org check + we don't use the result; drafts are returned via
    // a separate query so the join doesn't bloat each row.
    const owned = await context.db
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.campaignId, input.campaignId),
          eq(campaigns.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Campaign not found" });

    const rows = await context.db
      .select({
        turfDraftId: turfDrafts.turfDraftId,
        geometry: turfDrafts.geometry,
        sortOrder: turfDrafts.sortOrder,
      })
      .from(turfDrafts)
      .where(and(eq(turfDrafts.campaignId, input.campaignId), zoneIdMatch(input.zoneId)))
      .orderBy(asc(turfDrafts.sortOrder));
    return rows;
  });

// Atomic replace of every draft in a `(campaignId, zoneId)` scope.
// The cutter calls this after each meaningful change (polygon
// completion, vertex edit, deletion). Single round trip, single
// transaction — clients don't need per-row create-vs-update
// bookkeeping.
//
// `segmentId` is captured server-side from the campaign rather than
// trusted from the client, so a stale tab can't poison drafts with
// a segment that's no longer bound to the campaign.
export const replaceAll = pub
  .input(
    z.object({
      campaignId: z.string().uuid(),
      zoneId: nullableUuid,
      drafts: z.array(
        z.object({
          turfDraftId: z.string().uuid(),
          geometry: polygonSchema,
          sortOrder: z.number().int().nonnegative(),
        }),
      ),
    }),
  )
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ segmentId: campaigns.segmentId })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.campaignId, input.campaignId),
          eq(campaigns.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Campaign not found" });
    const segmentId = owned[0]!.segmentId;
    if (!segmentId) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Campaign has no bound segment; cannot save drafts",
      });
    }

    await context.db.transaction(async (tx) => {
      await tx
        .delete(turfDrafts)
        .where(and(eq(turfDrafts.campaignId, input.campaignId), zoneIdMatch(input.zoneId)));
      if (input.drafts.length > 0) {
        await tx.insert(turfDrafts).values(
          input.drafts.map((d) => ({
            turfDraftId: d.turfDraftId,
            campaignId: input.campaignId,
            zoneId: input.zoneId,
            segmentId,
            geometry: d.geometry,
            sortOrder: d.sortOrder,
          })),
        );
      }
    });

    return { ok: true as const };
  });

// Wipe every draft across every zone for a campaign. Used when the
// user changes the campaign's zone group (including zoned↔zoneless),
// since drafts are inherently scoped to a specific zoneId and would
// be orphaned by any rebind — even a "functionally identical" new
// zone group is treated as a fresh slate.
export const clearForCampaign = pub
  .input(z.object({ campaignId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.campaignId, input.campaignId),
          eq(campaigns.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Campaign not found" });

    const deleted = await context.db
      .delete(turfDrafts)
      .where(eq(turfDrafts.campaignId, input.campaignId))
      .returning({ turfDraftId: turfDrafts.turfDraftId });
    return { deleted: deleted.length };
  });
