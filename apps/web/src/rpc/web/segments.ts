import { ORPCError } from "@orpc/server";
import { and, asc, eq, ne } from "@field-tools/db";
import { campaigns, segments } from "@field-tools/db/schema";
import { z } from "zod";
import type { Criteria } from "~/lib/filters";
import { detectSegmentCycles, SegmentRefError, type SegmentLike } from "~/lib/segment-refs";
import { dataPostJson } from "~/lib/server/data-proxy";
import { webPub as pub } from "../context";

// Wire shapes returned by the data service. Kept here (next to the
// handlers that produce them) rather than at the query layer so the
// types travel with the RPC schema.
type PersonsCount = {
  personCount: number;
  doorCount: number;
  buildingCount: number;
};

type PersonsCountByKey = {
  counts: Record<string, { buildings: number; doors: number; people: number }>;
};

type PersonsSample = {
  persons: Array<{
    firstName: string | null;
    lastName: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip5: string | null;
  }>;
};

type BuildingsList = {
  buildings: Array<{
    buildingId: string;
    longitude: number;
    latitude: number;
    doorCount: number;
    personCount: number;
  }>;
};

const keyFilterSchema = z.object({ keyGroup: z.string(), keys: z.array(z.string()) }).nullish();

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
// Criteria is included so the segment-ref filter editor can resolve
// references and detect cycles without an extra round trip.
export const list = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  const rows = await context.db
    .select({ ...segmentSelect, criteria: segments.criteria })
    .from(segments)
    .where(eq(segments.organizationId, context.organizationId))
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
          eq(segments.organizationId, context.organizationId),
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
        organizationId: context.organizationId,
        name: input.name,
        criteria: { steps: [] },
        createdBy: context.user.id,
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
          eq(segments.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Segment not found" });
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
          eq(segments.organizationId, context.organizationId),
        ),
      );
    if (source.length === 0) throw new ORPCError("NOT_FOUND", { message: "Segment not found" });
    const src = source[0]!;
    const inserted = await context.db
      .insert(segments)
      .values({
        organizationId: context.organizationId,
        name: input.newName,
        criteria: src.criteria,
        voterFileId: src.voterFileId,
        voterFileVersion: src.voterFileVersion,
        createdBy: context.user.id,
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
          eq(segments.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Segment not found" });

    const inUse = await context.db
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .where(eq(campaigns.segmentId, input.segmentId));
    if (inUse.length > 0) {
      throw new ORPCError("CONFLICT", {
        message:
          `Segment is used by ${inUse.length} campaign${inUse.length === 1 ? "" : "s"}. ` +
          "Detach or delete those campaigns first.",
      });
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
          eq(segments.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Segment not found" });

    const refs = await context.db
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .where(eq(campaigns.segmentId, input.segmentId));
    return { count: refs.length };
  });

// Replace a segment's criteria. Used by the segment editor's save flow.
// The criteria shape is otherwise opaque at this layer, but segment
// references are walked here to reject cycles before they persist —
// the editor prevents them in the UI, this is a backstop.
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
          eq(segments.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) {
      throw new ORPCError("NOT_FOUND", { message: "Segment not found" });
    }

    const incoming = input.criteria as Criteria;
    const others = await context.db
      .select({
        segmentId: segments.segmentId,
        name: segments.name,
        criteria: segments.criteria,
      })
      .from(segments)
      .where(
        and(
          eq(segments.organizationId, context.organizationId),
          ne(segments.segmentId, input.segmentId),
        ),
      );
    const otherSegments = new Map<string, SegmentLike>(
      others.map((s) => [
        s.segmentId,
        { segmentId: s.segmentId, name: s.name, criteria: s.criteria as Criteria },
      ]),
    );
    try {
      detectSegmentCycles(input.segmentId, incoming, otherSegments);
    } catch (err) {
      if (err instanceof SegmentRefError)
        throw new ORPCError("BAD_REQUEST", {
          message: `Invalid segment references: ${err.message}`,
        });
      throw err;
    }

    await context.db
      .update(segments)
      .set({ criteria: input.criteria as object, updatedAt: new Date() })
      .where(eq(segments.segmentId, input.segmentId));
    return { ok: true as const };
  });

// Counts + sample for the segment editor's preview pane.
export const count = pub
  .input(z.object({ criteria: z.unknown() }))
  .handler(async ({ context, input }): Promise<PersonsCount> => {
    return dataPostJson<PersonsCount>("/persons/count", {
      criteria: input.criteria,
      orgSlug: context.orgSlug,
    });
  });

export type CascadeStep = { count: number; delta: number | null };
export const countCascade = pub
  .input(z.object({ criteria: z.unknown() }))
  .handler(async ({ context, input }): Promise<{ steps: CascadeStep[] }> => {
    return dataPostJson<{ steps: CascadeStep[] }>("/persons/count-cascade", {
      criteria: input.criteria,
      orgSlug: context.orgSlug,
    });
  });

export const sample = pub
  .input(z.object({ criteria: z.unknown(), limit: z.number().int().positive().optional() }))
  .handler(async ({ context, input }): Promise<PersonsSample> => {
    return dataPostJson<PersonsSample>("/persons/sample", {
      criteria: input.criteria,
      orgSlug: context.orgSlug,
      limit: input.limit ?? 100,
    });
  });

// Per-key counts for the campaign editor's heatmap overlay. `keyGroup`
// drives the GROUP BY column; `keyFilter` (optional) restricts the
// result set to a subset of keys (e.g. only the campaign's zone-group keys).
export const countByKey = pub
  .input(
    z.object({
      criteria: z.unknown(),
      keyGroup: z.string(),
      keyFilter: keyFilterSchema,
    }),
  )
  .handler(async ({ context, input }): Promise<PersonsCountByKey> => {
    return dataPostJson<PersonsCountByKey>("/persons/count-by-key", {
      criteria: input.criteria,
      keyGroup: input.keyGroup,
      keyFilter: input.keyFilter,
      orgSlug: context.orgSlug,
    });
  });

// Per-building rollups for the turf cutter — one row per building that
// contains at least one matching person.
export const listBuildings = pub
  .input(
    z.object({
      criteria: z.unknown(),
      keyFilter: keyFilterSchema,
    }),
  )
  .handler(async ({ context, input }): Promise<BuildingsList> => {
    return dataPostJson<BuildingsList>("/buildings/list", {
      criteria: input.criteria,
      keyFilter: input.keyFilter,
      orgSlug: context.orgSlug,
    });
  });
