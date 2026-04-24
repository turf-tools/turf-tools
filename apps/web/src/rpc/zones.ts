import { and, asc, eq } from "@field-tools/db";
import { zones } from "@field-tools/db/schema";
import { z } from "zod";
import { pub } from "./context";

const zoneSelect = {
  zoneId: zones.zoneId,
  name: zones.name,
  createdAt: zones.createdAt,
};

// List zones in the current user's organization, oldest first.
export const list = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  const rows = await context.db
    .select(zoneSelect)
    .from(zones)
    .where(eq(zones.organizationId, context.user.organizationId))
    .orderBy(asc(zones.createdAt));
  return rows;
});

// Fetch one zone by id, scoped to the user's organization.
export const getById = pub
  .input(z.object({ zoneId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(zoneSelect)
      .from(zones)
      .where(
        and(eq(zones.zoneId, input.zoneId), eq(zones.organizationId, context.user.organizationId)),
      );
    return rows[0] ?? null;
  });
