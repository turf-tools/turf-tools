import { and, asc, eq } from "@field-tools/db";
import { campaigns, segments } from "@field-tools/db/schema";
import { z } from "zod";
import { pub } from "./context";

const segmentSelect = {
  segmentId: segments.segmentId,
  name: segments.name,
  doorCount: segments.doorCount,
  personCount: segments.personCount,
  voterFileId: segments.voterFileId,
  voterFileVersion: segments.voterFileVersion,
  createdAt: segments.createdAt,
};

// List segments in the current user's organization, oldest first.
// Segments are now standalone — no campaign filter; campaigns reference
// segments, not the other way around.
export const list = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  const rows = await context.db
    .select(segmentSelect)
    .from(segments)
    .where(eq(segments.organizationId, context.user.organizationId))
    .orderBy(asc(segments.createdAt));
  return rows;
});

// Fetch one segment by id, scoped to the user's organization.
export const getById = pub
  .input(z.object({ segmentId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select({ ...segmentSelect, query: segments.query })
      .from(segments)
      .where(
        and(
          eq(segments.segmentId, input.segmentId),
          eq(segments.organizationId, context.user.organizationId),
        ),
      );
    return rows[0] ?? null;
  });

// Create an empty segment with the given name. Query starts empty —
// editor populates it via subsequent updateQuery calls.
export const create = pub
  .input(z.object({ name: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .insert(segments)
      .values({
        organizationId: context.user.organizationId,
        name: input.name,
        query: { filters: [] },
        createdBy: context.user.userId,
      })
      .returning();
    return rows[0]!;
  });

// Rename a segment. Org-scoped.
export const rename = pub
  .input(
    z.object({
      segmentId: z.string().uuid(),
      name: z.string().min(1),
    }),
  )
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ segmentId: segments.segmentId })
      .from(segments)
      .where(
        and(
          eq(segments.segmentId, input.segmentId),
          eq(segments.organizationId, context.user.organizationId),
        ),
      );
    if (owned.length === 0) throw new Error("Segment not found");
    await context.db
      .update(segments)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(segments.segmentId, input.segmentId));
    return { ok: true as const };
  });

// Clone a segment: creates a new segment with `newName` and copies the
// source's query. Returns the new id.
export const clone = pub
  .input(
    z.object({
      segmentId: z.string().uuid(),
      newName: z.string().min(1),
    }),
  )
  .handler(async ({ context, input }) => {
    const source = await context.db
      .select()
      .from(segments)
      .where(
        and(
          eq(segments.segmentId, input.segmentId),
          eq(segments.organizationId, context.user.organizationId),
        ),
      );
    if (source.length === 0) throw new Error("Segment not found");
    const src = source[0]!;
    const inserted = await context.db
      .insert(segments)
      .values({
        organizationId: context.user.organizationId,
        name: input.newName,
        query: src.query,
        voterFileId: src.voterFileId,
        voterFileVersion: src.voterFileVersion,
        createdBy: context.user.userId,
      })
      .returning({ segmentId: segments.segmentId });
    return { segmentId: inserted[0]!.segmentId };
  });

// Delete a segment. Blocks if any campaign still references it — same
// reasoning as zone groups: silently orphaning a campaign's segmentId is
// worse than a clear error.
export const remove = pub
  .input(z.object({ segmentId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ segmentId: segments.segmentId })
      .from(segments)
      .where(
        and(
          eq(segments.segmentId, input.segmentId),
          eq(segments.organizationId, context.user.organizationId),
        ),
      );
    if (owned.length === 0) throw new Error("Segment not found");

    const inUse = await context.db
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .where(eq(campaigns.segmentId, input.segmentId));
    if (inUse.length > 0) {
      throw new Error(
        `Segment is used by ${inUse.length} campaign${inUse.length === 1 ? "" : "s"}. ` +
          "Detach or delete those campaigns first.",
      );
    }

    await context.db.delete(segments).where(eq(segments.segmentId, input.segmentId));
    return { ok: true as const };
  });

// Count how many campaigns currently reference a given segment. Editor
// calls on demand (e.g. opening the delete dialog) so the answer is
// fresh — matching the zoneGroups.countCampaigns pattern.
export const countCampaigns = pub
  .input(z.object({ segmentId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ segmentId: segments.segmentId })
      .from(segments)
      .where(
        and(
          eq(segments.segmentId, input.segmentId),
          eq(segments.organizationId, context.user.organizationId),
        ),
      );
    if (owned.length === 0) throw new Error("Segment not found");

    const refs = await context.db
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .where(eq(campaigns.segmentId, input.segmentId));
    return { count: refs.length };
  });

// Replace a segment's query JSON. Used by the segment editor's save flow.
// The query shape is opaque at this layer — the editor and the data
// service interpret it; the web RPC just stores and returns it.
export const updateQuery = pub
  .input(
    z.object({
      segmentId: z.string().uuid(),
      query: z.unknown(),
    }),
  )
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ segmentId: segments.segmentId })
      .from(segments)
      .where(
        and(
          eq(segments.segmentId, input.segmentId),
          eq(segments.organizationId, context.user.organizationId),
        ),
      );
    if (owned.length === 0) {
      throw new Error("Segment not found");
    }
    await context.db
      .update(segments)
      .set({ query: input.query as object, updatedAt: new Date() })
      .where(eq(segments.segmentId, input.segmentId));
    return { ok: true as const };
  });
