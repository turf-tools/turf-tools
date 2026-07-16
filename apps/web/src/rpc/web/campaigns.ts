import { ORPCError } from "@orpc/server";
import { and, asc, eq } from "@field-tools/db";
import { campaigns } from "@field-tools/db/schema";
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

// Create a campaign with optional initial bindings. The New
// Campaign modal exposes the three FK selectors so users can pick
// segment/zone-group/script up front; if any is omitted the
// campaign is created with that binding null and the user can set
// it later via `update`.
export const create = pub
  .input(
    z.object({
      name: z.string().min(1),
      segmentId: z.string().uuid().nullish(),
      zoneGroupId: z.string().uuid().nullish(),
      scriptId: z.string().uuid().nullish(),
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
        segmentId: input.segmentId ?? null,
        zoneGroupId: input.zoneGroupId ?? null,
        scriptId: input.scriptId ?? null,
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

// Bind/unbind a campaign's foreign keys. Each FK is independently
// optional — pass null to clear a binding, undefined to leave it.
// Used by the dropdown commits in the campaign editor.
export const update = pub
  .input(
    z.object({
      campaignId: z.string().uuid(),
      segmentId: z.string().uuid().nullable().optional(),
      zoneGroupId: z.string().uuid().nullable().optional(),
      scriptId: z.string().uuid().nullable().optional(),
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

// Delete a campaign. (No turf-reference check yet — turfs.create
// hasn't shipped. When it does, mirror the segments/zone-groups
// pattern of blocking on dependent rows.)
export const remove = pub
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
    await context.db.delete(campaigns).where(eq(campaigns.campaignId, input.campaignId));
    return { ok: true as const };
  });
