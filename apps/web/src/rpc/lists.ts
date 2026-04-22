import { and, asc, eq } from "@field-tools/db";
import { lists } from "@field-tools/db/schema";
import { z } from "zod";
import { pub } from "./context";

const listSelect = {
  listId: lists.listId,
  trackId: lists.trackId,
  name: lists.name,
  doorCount: lists.doorCount,
  personCount: lists.personCount,
  voterFileId: lists.voterFileId,
  voterFileVersion: lists.voterFileVersion,
  createdAt: lists.createdAt,
};

// List lists in the current user's organization, optionally filtered to a
// specific track. Oldest first.
export const list = pub
  .input(z.object({ trackId: z.string().uuid().optional() }).optional())
  .handler(async ({ context, input }) => {
    const orgFilter = eq(lists.organizationId, context.user.organizationId);
    const where = input?.trackId ? and(orgFilter, eq(lists.trackId, input.trackId)) : orgFilter;
    const rows = await context.db
      .select(listSelect)
      .from(lists)
      .where(where)
      .orderBy(asc(lists.createdAt));
    return rows;
  });

// Fetch one list by id, scoped to the user's organization.
export const getById = pub
  .input(z.object({ listId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(listSelect)
      .from(lists)
      .where(
        and(eq(lists.listId, input.listId), eq(lists.organizationId, context.user.organizationId)),
      );
    return rows[0] ?? null;
  });
