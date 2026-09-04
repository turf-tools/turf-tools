import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, type Db } from "@turf-tools/db";
import { zoneGroups, zones } from "@turf-tools/db/schema";
import { z } from "zod";
import { webPub as pub } from "../context";

// Zone writes bump the parent group's updatedAt — the change signal
// report pages fold into their perimeter cache keys.
async function touchZoneGroup(db: Db, zoneGroupId: string) {
  await db
    .update(zoneGroups)
    .set({ updatedAt: new Date() })
    .where(eq(zoneGroups.zoneGroupId, zoneGroupId));
}

const zoneSelect = {
  zoneId: zones.zoneId,
  zoneGroupId: zones.zoneGroupId,
  name: zones.name,
  keys: zones.keys,
  order: zones.order,
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
      .orderBy(asc(zones.order), asc(zones.createdAt));
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
      .select({ zoneId: zones.zoneId, zoneGroupId: zones.zoneGroupId })
      .from(zones)
      .innerJoin(zoneGroups, eq(zones.zoneGroupId, zoneGroups.zoneGroupId))
      .where(
        and(eq(zones.zoneId, input.zoneId), eq(zoneGroups.organizationId, context.organizationId)),
      );
    if (owned.length === 0) {
      throw new ORPCError("NOT_FOUND", { message: "Zone not found" });
    }
    await context.db
      .update(zones)
      .set({ keys: input.keys, updatedAt: new Date() })
      .where(eq(zones.zoneId, input.zoneId));
    await touchZoneGroup(context.db, owned[0]!.zoneGroupId);
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
      .select({ zoneId: zones.zoneId, zoneGroupId: zones.zoneGroupId })
      .from(zones)
      .innerJoin(zoneGroups, eq(zones.zoneGroupId, zoneGroups.zoneGroupId))
      .where(
        and(eq(zones.zoneId, input.zoneId), eq(zoneGroups.organizationId, context.organizationId)),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Zone not found" });
    await context.db
      .update(zones)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(zones.zoneId, input.zoneId));
    await touchZoneGroup(context.db, owned[0]!.zoneGroupId);
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
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Zone group not found" });

    // New zones append: one past the group's current max order.
    const last = await context.db
      .select({ order: zones.order })
      .from(zones)
      .where(eq(zones.zoneGroupId, input.zoneGroupId))
      .orderBy(desc(zones.order))
      .limit(1);
    const rows = await context.db
      .insert(zones)
      .values({
        zoneGroupId: input.zoneGroupId,
        name: input.name,
        keys: [],
        order: (last[0]?.order ?? -1) + 1,
        createdBy: context.user.id,
      })
      .returning();
    await touchZoneGroup(context.db, input.zoneGroupId);
    return rows[0]!;
  });

// Persist a full ordering for a group's zones: each zone's `order` becomes
// its index in `zoneIds`. Org check via the parent group; ids not in the
// group are ignored by the per-row scope.
export const reorder = pub
  .input(
    z.object({
      zoneGroupId: z.string().uuid(),
      zoneIds: z.array(z.string().uuid()),
    }),
  )
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ zoneGroupId: zoneGroups.zoneGroupId })
      .from(zoneGroups)
      .where(
        and(
          eq(zoneGroups.zoneGroupId, input.zoneGroupId),
          eq(zoneGroups.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Zone group not found" });

    await context.db.transaction(async (tx) => {
      for (const [index, zoneId] of input.zoneIds.entries()) {
        await tx
          .update(zones)
          .set({ order: index, updatedAt: new Date() })
          .where(and(eq(zones.zoneId, zoneId), eq(zones.zoneGroupId, input.zoneGroupId)));
      }
    });
    return { ok: true as const };
  });

// Delete a zone. Org check via parent group.
export const remove = pub
  .input(z.object({ zoneId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ zoneId: zones.zoneId, zoneGroupId: zones.zoneGroupId })
      .from(zones)
      .innerJoin(zoneGroups, eq(zones.zoneGroupId, zoneGroups.zoneGroupId))
      .where(
        and(eq(zones.zoneId, input.zoneId), eq(zoneGroups.organizationId, context.organizationId)),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Zone not found" });
    await context.db.delete(zones).where(eq(zones.zoneId, input.zoneId));
    await touchZoneGroup(context.db, owned[0]!.zoneGroupId);
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
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Zone group not found" });
    await context.db.delete(zones).where(eq(zones.zoneGroupId, input.zoneGroupId));
    await touchZoneGroup(context.db, input.zoneGroupId);
    return { ok: true as const };
  });
