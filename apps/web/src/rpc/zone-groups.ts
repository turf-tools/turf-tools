import { and, asc, eq } from "@field-tools/db";
import { campaigns, zoneGroups, zones } from "@field-tools/db/schema";
import { z } from "zod";
import { pub } from "./context";

const zoneGroupSelect = {
  zoneGroupId: zoneGroups.zoneGroupId,
  name: zoneGroups.name,
  keyGroup: zoneGroups.keyGroup,
  createdAt: zoneGroups.createdAt,
  updatedAt: zoneGroups.updatedAt,
};

// List zone groups in the current user's organization, oldest first.
export const list = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  const rows = await context.db
    .select(zoneGroupSelect)
    .from(zoneGroups)
    .where(eq(zoneGroups.organizationId, context.user.organizationId))
    .orderBy(asc(zoneGroups.createdAt));
  return rows;
});

// Count how many campaigns currently reference a given zone group. The
// editor calls this on demand (e.g. when opening the delete dialog) so
// the answer is fresh — caching the count in `list` would go stale the
// moment a campaign elsewhere is created or detached.
export const countCampaigns = pub
  .input(z.object({ zoneGroupId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ zoneGroupId: zoneGroups.zoneGroupId })
      .from(zoneGroups)
      .where(
        and(
          eq(zoneGroups.zoneGroupId, input.zoneGroupId),
          eq(zoneGroups.organizationId, context.user.organizationId),
        ),
      );
    if (owned.length === 0) throw new Error("Zone group not found");

    const refs = await context.db
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .where(eq(campaigns.zoneGroupId, input.zoneGroupId));
    return { count: refs.length };
  });

// Fetch one zone group by id, scoped to the user's organization.
export const getById = pub
  .input(z.object({ zoneGroupId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(zoneGroupSelect)
      .from(zoneGroups)
      .where(
        and(
          eq(zoneGroups.zoneGroupId, input.zoneGroupId),
          eq(zoneGroups.organizationId, context.user.organizationId),
        ),
      );
    return rows[0] ?? null;
  });

// Create an empty zone group with the given name + key group. The key
// group is immutable once set — to switch, create a new group.
export const create = pub
  .input(
    z.object({
      name: z.string().min(1),
      keyGroup: z.string().min(1),
    }),
  )
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .insert(zoneGroups)
      .values({
        organizationId: context.user.organizationId,
        name: input.name,
        keyGroup: input.keyGroup,
        createdBy: context.user.userId,
      })
      .returning(zoneGroupSelect);
    return rows[0]!;
  });

// Rename a zone group. Org-scoped.
export const rename = pub
  .input(
    z.object({
      zoneGroupId: z.string().uuid(),
      name: z.string().min(1),
    }),
  )
  .handler(async ({ context, input }) => {
    await context.db
      .update(zoneGroups)
      .set({ name: input.name, updatedAt: new Date() })
      .where(
        and(
          eq(zoneGroups.zoneGroupId, input.zoneGroupId),
          eq(zoneGroups.organizationId, context.user.organizationId),
        ),
      );
    return { ok: true as const };
  });

// Delete a zone group and every zone inside it (zones cascade via FK).
// Blocks deletion if any campaign still references this group, since
// orphaning a campaign's zoneGroupId silently is worse than a clear error.
export const remove = pub
  .input(z.object({ zoneGroupId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ zoneGroupId: zoneGroups.zoneGroupId })
      .from(zoneGroups)
      .where(
        and(
          eq(zoneGroups.zoneGroupId, input.zoneGroupId),
          eq(zoneGroups.organizationId, context.user.organizationId),
        ),
      );
    if (owned.length === 0) throw new Error("Zone group not found");

    const inUse = await context.db
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .where(eq(campaigns.zoneGroupId, input.zoneGroupId));
    if (inUse.length > 0) {
      throw new Error(
        `Zone group is used by ${inUse.length} campaign${inUse.length === 1 ? "" : "s"}. ` +
          "Detach or delete those campaigns first.",
      );
    }

    await context.db.delete(zoneGroups).where(eq(zoneGroups.zoneGroupId, input.zoneGroupId));
    return { ok: true as const };
  });

// Clone a zone group: creates a new group with `newName` and copies every
// zone from the source. Same key group as the source. Returns the new id.
export const clone = pub
  .input(
    z.object({
      zoneGroupId: z.string().uuid(),
      newName: z.string().min(1),
    }),
  )
  .handler(async ({ context, input }) => {
    const source = await context.db
      .select()
      .from(zoneGroups)
      .where(
        and(
          eq(zoneGroups.zoneGroupId, input.zoneGroupId),
          eq(zoneGroups.organizationId, context.user.organizationId),
        ),
      );
    if (source.length === 0) throw new Error("Zone group not found");
    const src = source[0]!;

    const inserted = await context.db
      .insert(zoneGroups)
      .values({
        organizationId: context.user.organizationId,
        name: input.newName,
        keyGroup: src.keyGroup,
        createdBy: context.user.userId,
      })
      .returning({ zoneGroupId: zoneGroups.zoneGroupId });
    const newId = inserted[0]!.zoneGroupId;

    const sourceZones = await context.db
      .select()
      .from(zones)
      .where(eq(zones.zoneGroupId, src.zoneGroupId));
    if (sourceZones.length > 0) {
      await context.db.insert(zones).values(
        sourceZones.map((z) => ({
          zoneGroupId: newId,
          name: z.name,
          keys: z.keys,
          createdBy: context.user.userId,
        })),
      );
    }

    return { zoneGroupId: newId };
  });
