import { and, asc, eq } from "@field-tools/db";
import { zoneGroups, zones } from "@field-tools/db/schema";
import { z } from "zod";
import { webPub as pub } from "../context";

const zoneSelect = {
  zoneId: zones.zoneId,
  zoneGroupId: zones.zoneGroupId,
  name: zones.name,
  keys: zones.keys,
  createdAt: zones.createdAt,
  updatedAt: zones.updatedAt,
};

// List zones in a given zone group, scoped to the user's organization.
// Org check goes through the parent zone group since `zones` doesn't carry
// `organizationId` directly.
export const list = pub
  .input(z.object({ zoneGroupId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(zoneSelect)
      .from(zones)
      .innerJoin(zoneGroups, eq(zones.zoneGroupId, zoneGroups.zoneGroupId))
      .where(
        and(
          eq(zones.zoneGroupId, input.zoneGroupId),
          eq(zoneGroups.organizationId, context.organizationId),
        ),
      )
      .orderBy(asc(zones.createdAt));
    return rows;
  });

// Fetch one zone by id, scoped to the user's organization (via parent group).
export const getById = pub
  .input(z.object({ zoneId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(zoneSelect)
      .from(zones)
      .innerJoin(zoneGroups, eq(zones.zoneGroupId, zoneGroups.zoneGroupId))
      .where(
        and(eq(zones.zoneId, input.zoneId), eq(zoneGroups.organizationId, context.organizationId)),
      );
    return rows[0] ?? null;
  });

// Replace a zone's keys array. Used by the zone editor when the user
// clicks polygons on the map. Validates org scope through the parent
// group; throws if the zone doesn't belong to the user's org.
export const updateKeys = pub
  .input(
    z.object({
      zoneId: z.string().uuid(),
      keys: z.array(z.string()),
    }),
  )
  .handler(async ({ context, input }) => {
    // Org check via parent zone group.
    const owned = await context.db
      .select({ zoneId: zones.zoneId })
      .from(zones)
      .innerJoin(zoneGroups, eq(zones.zoneGroupId, zoneGroups.zoneGroupId))
      .where(
        and(eq(zones.zoneId, input.zoneId), eq(zoneGroups.organizationId, context.organizationId)),
      );
    if (owned.length === 0) {
      throw new Error("Zone not found");
    }
    await context.db
      .update(zones)
      .set({ keys: input.keys, updatedAt: new Date() })
      .where(eq(zones.zoneId, input.zoneId));
    return { ok: true as const };
  });

// Rename a zone. Org check via parent group.
export const rename = pub
  .input(
    z.object({
      zoneId: z.string().uuid(),
      name: z.string().min(1),
    }),
  )
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ zoneId: zones.zoneId })
      .from(zones)
      .innerJoin(zoneGroups, eq(zones.zoneGroupId, zoneGroups.zoneGroupId))
      .where(
        and(eq(zones.zoneId, input.zoneId), eq(zoneGroups.organizationId, context.organizationId)),
      );
    if (owned.length === 0) throw new Error("Zone not found");
    await context.db
      .update(zones)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(zones.zoneId, input.zoneId));
    return { ok: true as const };
  });

// Create an empty zone in a zone group. Org check via the parent group.
export const create = pub
  .input(
    z.object({
      zoneGroupId: z.string().uuid(),
      name: z.string().min(1),
    }),
  )
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select()
      .from(zoneGroups)
      .where(
        and(
          eq(zoneGroups.zoneGroupId, input.zoneGroupId),
          eq(zoneGroups.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new Error("Zone group not found");

    const rows = await context.db
      .insert(zones)
      .values({
        zoneGroupId: input.zoneGroupId,
        name: input.name,
        keys: [],
        createdBy: context.user.id,
      })
      .returning();
    return rows[0]!;
  });

// Delete a zone. Org check via parent group.
export const remove = pub
  .input(z.object({ zoneId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ zoneId: zones.zoneId })
      .from(zones)
      .innerJoin(zoneGroups, eq(zones.zoneGroupId, zoneGroups.zoneGroupId))
      .where(
        and(eq(zones.zoneId, input.zoneId), eq(zoneGroups.organizationId, context.organizationId)),
      );
    if (owned.length === 0) throw new Error("Zone not found");
    await context.db.delete(zones).where(eq(zones.zoneId, input.zoneId));
    return { ok: true as const };
  });

// Delete every zone inside a zone group (group itself stays). Used by the
// "Clear" button in the zone editor.
export const removeAllInGroup = pub
  .input(z.object({ zoneGroupId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select()
      .from(zoneGroups)
      .where(
        and(
          eq(zoneGroups.zoneGroupId, input.zoneGroupId),
          eq(zoneGroups.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new Error("Zone group not found");
    await context.db.delete(zones).where(eq(zones.zoneGroupId, input.zoneGroupId));
    return { ok: true as const };
  });
