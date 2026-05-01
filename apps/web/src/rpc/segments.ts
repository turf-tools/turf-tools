import { and, asc, type Db, eq } from "@field-tools/db";
import { campaigns, organizations, segments } from "@field-tools/db/schema";
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
      .select({ ...segmentSelect, criteria: segments.criteria })
      .from(segments)
      .where(
        and(
          eq(segments.segmentId, input.segmentId),
          eq(segments.organizationId, context.user.organizationId),
        ),
      );
    return rows[0] ?? null;
  });

// Create an empty segment with the given name. Criteria starts empty —
// editor populates it via subsequent updateCriteria calls.
export const create = pub
  .input(z.object({ name: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .insert(segments)
      .values({
        organizationId: context.user.organizationId,
        name: input.name,
        criteria: { filters: [] },
        createdBy: context.user.userId,
      })
      .returning({ ...segmentSelect, criteria: segments.criteria });
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
// source's criteria. Returns the full new row.
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
        criteria: src.criteria,
        voterFileId: src.voterFileId,
        voterFileVersion: src.voterFileVersion,
        createdBy: context.user.userId,
      })
      .returning({ ...segmentSelect, criteria: segments.criteria });
    return inserted[0]!;
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

// Count how many campaigns currently reference a given segment.
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

// Replace a segment's criteria. Used by the segment editor's save flow.
// The criteria shape is opaque at this layer — the editor and the data
// service interpret it; the web RPC just stores and returns it.
export const updateCriteria = pub
  .input(
    z.object({
      segmentId: z.string().uuid(),
      criteria: z.unknown(),
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
      .set({ criteria: input.criteria as object, updatedAt: new Date() })
      .where(eq(segments.segmentId, input.segmentId));
    return { ok: true as const };
  });

// Resolve the user's org slug from the auth context. The data service
// uses it to namespace the persons/buildings tables.
export async function loadOrgSlug(context: {
  db: Db;
  user: { organizationId: string };
}): Promise<string> {
  const rows = await context.db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.organizationId, context.user.organizationId));
  const slug = rows[0]?.slug;
  if (!slug) throw new Error("Organization not found");
  return slug;
}
