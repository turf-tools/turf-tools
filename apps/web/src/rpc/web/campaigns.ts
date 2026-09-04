import { ORPCError } from "@orpc/server";
import { and, asc, eq, sql, type Db } from "@turf-tools/db";
import { campaigns, turfs } from "@turf-tools/db/schema";
import { z } from "zod";
import { webPub as pub } from "../context";
import { activeDatasetId } from "./active-dataset";

const campaignSelect = {
  campaignId: campaigns.campaignId,
  name: campaigns.name,
  startsAt: campaigns.startsAt,
  endsAt: campaigns.endsAt,
  segmentId: campaigns.segmentId,
  zoneGroupId: campaigns.zoneGroupId,
  scriptId: campaigns.scriptId,
  createdAt: campaigns.createdAt,
  isArchived: sql<boolean>`(${campaigns.archivedAt} IS NOT NULL)`,
};

// List campaigns in the current user's organization, oldest first.
export const list = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  // Scoped to the active-dataset workspace. No active dataset → empty list.
  const datasetId = await activeDatasetId(context.db, context.organizationId);
  if (!datasetId) return [];
  const rows = await context.db
    .select(campaignSelect)
    .from(campaigns)
    .where(
      and(eq(campaigns.organizationId, context.organizationId), eq(campaigns.datasetId, datasetId)),
    )
    .orderBy(asc(campaigns.createdAt));
  return rows;
});

// Fetch one campaign by id, scoped to the user's organization.
export const getById = pub
  .input(z.object({ campaignId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(campaignSelect)
      .from(campaigns)
      .where(
        and(
          eq(campaigns.campaignId, input.campaignId),
          eq(campaigns.organizationId, context.organizationId),
        ),
      );
    return rows[0] ?? null;
  });

// Create a campaign. The zone group is the one optional binding —
// omitted, the campaign is zoneless and turfs cut against the whole
// segment.
export const create = pub
  .input(
    z.object({
      name: z.string().min(1),
      segmentId: z.string().uuid(),
      zoneGroupId: z.string().uuid().nullish(),
      scriptId: z.string().uuid(),
    }),
  )
  .handler(async ({ context, input }) => {
    const datasetId = await activeDatasetId(context.db, context.organizationId);
    if (!datasetId)
      throw new ORPCError("BAD_REQUEST", {
        message: "Activate a dataset in Data before creating a campaign.",
      });
    const rows = await context.db
      .insert(campaigns)
      .values({
        organizationId: context.organizationId,
        datasetId,
        name: input.name,
        segmentId: input.segmentId,
        zoneGroupId: input.zoneGroupId ?? null,
        scriptId: input.scriptId,
        createdBy: context.user.id,
      })
      .returning(campaignSelect);
    return rows[0]!;
  });

// Rename a campaign.
export const rename = pub
  .input(
    z.object({
      campaignId: z.string().uuid(),
      name: z.string().min(1),
    }),
  )
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
    await context.db
      .update(campaigns)
      .set({ name: input.name })
      .where(eq(campaigns.campaignId, input.campaignId));
    return { ok: true as const };
  });

// Rebind a campaign. Undefined leaves a binding untouched; null clears
// the zone group (→ zoneless), the only binding that can be removed.
// Used by the dropdown commits in the campaign editor.
export const update = pub
  .input(
    z.object({
      campaignId: z.string().uuid(),
      segmentId: z.string().uuid().optional(),
      zoneGroupId: z.string().uuid().nullable().optional(),
      scriptId: z.string().uuid().optional(),
    }),
  )
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
    const patch: Record<string, string | null> = {};
    if (input.segmentId !== undefined) patch.segmentId = input.segmentId;
    if (input.zoneGroupId !== undefined) patch.zoneGroupId = input.zoneGroupId;
    if (input.scriptId !== undefined) patch.scriptId = input.scriptId;
    if (Object.keys(patch).length === 0) return { ok: true as const };
    await context.db.update(campaigns).set(patch).where(eq(campaigns.campaignId, input.campaignId));
    return { ok: true as const };
  });

// Clone a campaign: copies name + all FKs into a new row with the
// supplied `newName`. Returns the full new row.
export const clone = pub
  .input(
    z.object({
      campaignId: z.string().uuid(),
      newName: z.string().min(1),
    }),
  )
  .handler(async ({ context, input }) => {
    const source = await context.db
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.campaignId, input.campaignId),
          eq(campaigns.organizationId, context.organizationId),
        ),
      );
    if (source.length === 0) throw new ORPCError("NOT_FOUND", { message: "Campaign not found" });
    const src = source[0]!;
    const inserted = await context.db
      .insert(campaigns)
      .values({
        organizationId: context.organizationId,
        datasetId: src.datasetId,
        name: input.newName,
        startsAt: src.startsAt,
        endsAt: src.endsAt,
        segmentId: src.segmentId,
        zoneGroupId: src.zoneGroupId,
        scriptId: src.scriptId,
        createdBy: context.user.id,
      })
      .returning(campaignSelect);
    return inserted[0]!;
  });

// Soft-retire a campaign: it leaves active lists and its turfs drop out
// of the turfs view, but turf codes keep working and nothing is deleted.
// Campaigns with turfs are the anchor of turf history and live forever;
// only archived, turf-less ones can be deleted.
export const archive = pub
  .input(z.object({ campaignId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const updated = await context.db
      .update(campaigns)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(campaigns.campaignId, input.campaignId),
          eq(campaigns.organizationId, context.organizationId),
        ),
      )
      .returning({ campaignId: campaigns.campaignId });
    if (updated.length === 0) throw new ORPCError("NOT_FOUND", { message: "Campaign not found" });
    return { ok: true as const };
  });

export const unarchive = pub
  .input(z.object({ campaignId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const updated = await context.db
      .update(campaigns)
      .set({ archivedAt: null })
      .where(
        and(
          eq(campaigns.campaignId, input.campaignId),
          eq(campaigns.organizationId, context.organizationId),
        ),
      )
      .returning({ campaignId: campaigns.campaignId });
    if (updated.length === 0) throw new ORPCError("NOT_FOUND", { message: "Campaign not found" });
    return { ok: true as const };
  });

// Everything holding a reference to a campaign, regardless of status —
// permanent deletion must respect archived referencers too. Turfs are
// the only hard edge; turf drafts are working state and cascade.
async function removalBlockers(
  db: Db,
  campaignId: string,
): Promise<Array<{ label: string; count: number }>> {
  const turfRefs = await db
    .select({ turfId: turfs.turfId })
    .from(turfs)
    .where(eq(turfs.campaignId, campaignId));
  return [{ label: "turf", count: turfRefs.length }].filter((b) => b.count > 0);
}

// What blocks permanent deletion, for the delete dialog. Empty = deletable.
export const removeCheck = pub
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
    return { blockers: await removalBlockers(context.db, input.campaignId) };
  });

// Permanently delete an archived campaign that never published a turf
// (drafts cascade). The blocker check re-runs here and the FKs backstop
// any race.
export const remove = pub
  .input(z.object({ campaignId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select({ archivedAt: campaigns.archivedAt })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.campaignId, input.campaignId),
          eq(campaigns.organizationId, context.organizationId),
        ),
      );
    if (rows.length === 0) throw new ORPCError("NOT_FOUND", { message: "Campaign not found" });
    if (!rows[0]!.archivedAt)
      throw new ORPCError("BAD_REQUEST", { message: "Only archived campaigns can be deleted" });
    const blockers = await removalBlockers(context.db, input.campaignId);
    if (blockers.length > 0)
      throw new ORPCError("BAD_REQUEST", {
        message: "This campaign is still referenced and can't be deleted",
      });
    await context.db.delete(campaigns).where(eq(campaigns.campaignId, input.campaignId));
    return { ok: true as const };
  });
