import { and, asc, eq } from "@field-tools/db";
import { tracks } from "@field-tools/db/schema";
import { z } from "zod";
import { pub } from "./context";

const trackSelect = {
  trackId: tracks.trackId,
  name: tracks.name,
  startsAt: tracks.startsAt,
  endsAt: tracks.endsAt,
  createdAt: tracks.createdAt,
};

// List tracks in the current user's organization, oldest first.
export const list = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  const rows = await context.db
    .select(trackSelect)
    .from(tracks)
    .where(eq(tracks.organizationId, context.user.organizationId))
    .orderBy(asc(tracks.createdAt));
  return rows;
});

// Fetch one track by id, scoped to the user's organization.
export const getById = pub
  .input(z.object({ trackId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(trackSelect)
      .from(tracks)
      .where(
        and(
          eq(tracks.trackId, input.trackId),
          eq(tracks.organizationId, context.user.organizationId),
        ),
      );
    return rows[0] ?? null;
  });
