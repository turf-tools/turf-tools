import { ORPCError } from "@orpc/server";
import { and, asc, eq, isNull, sql, type Db } from "@turf-tools/db";
import {
  campaigns,
  segments as segmentsTable,
  turfs,
  zoneGroups,
  zones,
} from "@turf-tools/db/schema";
import { z } from "zod";
import { dataPostJson } from "~/lib/server/data-proxy";
import { webPub as pub } from "../context";
import { activeDatasetId } from "./active-dataset";

const zoneGroupSelect = {
  zoneGroupId: zoneGroups.zoneGroupId,
  name: zoneGroups.name,
  keyGroup: zoneGroups.keyGroup,
  createdAt: zoneGroups.createdAt,
  updatedAt: zoneGroups.updatedAt,
  isArchived: sql<boolean>`(${zoneGroups.archivedAt} IS NOT NULL)`,
};

// List zone groups in the current user's organization, oldest first.
export const list = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  // Scoped to the active-dataset workspace. No active dataset → empty list.
  const datasetId = await activeDatasetId(context.db, context.organizationId);
  if (!datasetId) return [];
  const rows = await context.db
    .select(zoneGroupSelect)
    .from(zoneGroups)
    .where(
      and(
        eq(zoneGroups.organizationId, context.organizationId),
        eq(zoneGroups.datasetId, datasetId),
      ),
    )
    .orderBy(asc(zoneGroups.createdAt));
  return rows;
});

// Count the active campaigns referencing a given zone group. The editor
// calls this on demand (when archiving) so the answer is fresh — caching
// the count in `list` would go stale the moment a campaign elsewhere is
// created or detached. References from archived campaigns are expected
// history and aren't counted.
export const countCampaigns = pub
  .input(z.object({ zoneGroupId: z.string().uuid() }))
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

    const refs = await context.db
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .where(and(eq(campaigns.zoneGroupId, input.zoneGroupId), isNull(campaigns.archivedAt)));
    return { count: refs.length };
  });

// Everything holding a reference to a zone group, regardless of status —
// permanent deletion must respect archived referencers too, unlike the
// archive warning above. Zones are the group's own children and cascade
// on delete.
async function removalBlockers(
  db: Db,
  zoneGroupId: string,
): Promise<Array<{ label: string; count: number }>> {
  const [campaignRefs, turfRefs] = await Promise.all([
    db
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .where(eq(campaigns.zoneGroupId, zoneGroupId)),
    db.select({ turfId: turfs.turfId }).from(turfs).where(eq(turfs.zoneGroupId, zoneGroupId)),
  ]);
  return [
    { label: "campaign", count: campaignRefs.length },
    { label: "turf", count: turfRefs.length },
  ].filter((b) => b.count > 0);
}

// What blocks permanent deletion, for the delete dialog. Empty = deletable.
export const removeCheck = pub
  .input(z.object({ zoneGroupId: z.string().uuid() }))
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
    return { blockers: await removalBlockers(context.db, input.zoneGroupId) };
  });

// Permanently delete an archived, unreferenced zone group (zones cascade).
// The blocker check re-runs here and the FKs backstop any race.
export const remove = pub
  .input(z.object({ zoneGroupId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select({ archivedAt: zoneGroups.archivedAt })
      .from(zoneGroups)
      .where(
        and(
          eq(zoneGroups.zoneGroupId, input.zoneGroupId),
          eq(zoneGroups.organizationId, context.organizationId),
        ),
      );
    if (rows.length === 0) throw new ORPCError("NOT_FOUND", { message: "Zone group not found" });
    if (!rows[0]!.archivedAt)
      throw new ORPCError("BAD_REQUEST", { message: "Only archived zone groups can be deleted" });
    const blockers = await removalBlockers(context.db, input.zoneGroupId);
    if (blockers.length > 0)
      throw new ORPCError("BAD_REQUEST", {
        message: "This zone group is still referenced and can't be deleted",
      });
    await context.db.delete(zoneGroups).where(eq(zoneGroups.zoneGroupId, input.zoneGroupId));
    return { ok: true as const };
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
          eq(zoneGroups.organizationId, context.organizationId),
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
    const datasetId = await activeDatasetId(context.db, context.organizationId);
    if (!datasetId)
      throw new ORPCError("BAD_REQUEST", {
        message: "Activate a dataset in Data before creating a zone group.",
      });
    const rows = await context.db
      .insert(zoneGroups)
      .values({
        organizationId: context.organizationId,
        datasetId,
        name: input.name,
        keyGroup: input.keyGroup,
        createdBy: context.user.id,
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
          eq(zoneGroups.organizationId, context.organizationId),
        ),
      );
    return { ok: true as const };
  });

// Soft-retire a zone group: it leaves the rail and pickers but stays
// resolvable for the campaigns and turfs that reference it. There is
// no delete — turfs and campaigns reference zone groups forever.
export const archive = pub
  .input(z.object({ zoneGroupId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const updated = await context.db
      .update(zoneGroups)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(zoneGroups.zoneGroupId, input.zoneGroupId),
          eq(zoneGroups.organizationId, context.organizationId),
        ),
      )
      .returning({ zoneGroupId: zoneGroups.zoneGroupId });
    if (updated.length === 0) throw new ORPCError("NOT_FOUND", { message: "Zone group not found" });
    return { ok: true as const };
  });

export const unarchive = pub
  .input(z.object({ zoneGroupId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const updated = await context.db
      .update(zoneGroups)
      .set({ archivedAt: null })
      .where(
        and(
          eq(zoneGroups.zoneGroupId, input.zoneGroupId),
          eq(zoneGroups.organizationId, context.organizationId),
        ),
      )
      .returning({ zoneGroupId: zoneGroups.zoneGroupId });
    if (updated.length === 0) throw new ORPCError("NOT_FOUND", { message: "Zone group not found" });
    return { ok: true as const };
  });

// Clone a zone group: creates a new group with `newName` and copies every
// zone from the source. Same key group as the source. Returns the full new row.
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
          eq(zoneGroups.organizationId, context.organizationId),
        ),
      );
    if (source.length === 0) throw new ORPCError("NOT_FOUND", { message: "Zone group not found" });
    const src = source[0]!;

    const inserted = await context.db
      .insert(zoneGroups)
      .values({
        organizationId: context.organizationId,
        datasetId: src.datasetId,
        name: input.newName,
        keyGroup: src.keyGroup,
        createdBy: context.user.id,
      })
      .returning(zoneGroupSelect);
    const created = inserted[0]!;

    const sourceZones = await context.db
      .select()
      .from(zones)
      .where(eq(zones.zoneGroupId, src.zoneGroupId));
    if (sourceZones.length > 0) {
      await context.db.insert(zones).values(
        sourceZones.map((z) => ({
          zoneGroupId: created.zoneGroupId,
          name: z.name,
          keys: z.keys,
          createdBy: context.user.id,
        })),
      );
    }

    return created;
  });

// One-shot "skip the zones editor and just give me a zone group with
// one giant zone" path used by the New Campaign modal. Creates a
// zone group + a single default zone whose keys are the distinct
// values of `keyGroup`'s boundary-key expression over voters
// matched by `segmentId`.
//
// The keys are scoped to the segment (not "every key in this
// keyGroup") so the resulting polygon visually traces only where
// canvassing will actually happen — see the `boundaryKeyExprFor`
// usage in segments.countByKey for the same pattern.
//
// Snapshot semantics: the keys are recorded on the zone at creation
// time. If the user later edits the segment, this zone's keys will
// drift from "what the segment matches now". Same drift applies to
// any manually-built zone group; we'd address with a "Refresh from
// segment" affordance if it bites.
export const createWithDefaultZone = pub
  .input(
    z.object({
      name: z.string().min(1),
      keyGroup: z.string().min(1),
      segmentId: z.string().uuid(),
    }),
  )
  .handler(async ({ context, input }) => {
    const datasetId = await activeDatasetId(context.db, context.organizationId);
    if (!datasetId)
      throw new ORPCError("BAD_REQUEST", {
        message: "Activate a dataset in Data before creating a zone group.",
      });

    // 1. Pull the segment's criteria, scoped to org.
    const segmentRows = await context.db
      .select({ criteria: segmentsTable.criteria })
      .from(segmentsTable)
      .where(
        and(
          eq(segmentsTable.segmentId, input.segmentId),
          eq(segmentsTable.organizationId, context.organizationId),
        ),
      );
    const segment = segmentRows[0];
    if (!segment) throw new ORPCError("NOT_FOUND", { message: "Segment not found" });

    // 2. Resolve the segment's distinct key values via the data
    // app's per-key counts endpoint — we only care about which keys
    // appear, not the counts. The auto-zone covers every key the
    // segment produces in this key group.
    const result = await dataPostJson<{
      counts: Record<string, { doors: number; people: number }>;
    }>("/persons/count-by-key", {
      criteria: segment.criteria,
      keyGroup: input.keyGroup,
      keyFilter: null,
      orgSlug: context.orgSlug,
    });
    const keys = Object.keys(result.counts).sort();

    // 3. Insert zone group + zone in one transaction so a partial
    // failure can't leave a zone-less group behind.
    const created = await context.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(zoneGroups)
        .values({
          organizationId: context.organizationId,
          datasetId,
          name: input.name,
          keyGroup: input.keyGroup,
          createdBy: context.user.id,
        })
        .returning(zoneGroupSelect);
      const zg = inserted[0]!;

      await tx.insert(zones).values({
        zoneGroupId: zg.zoneGroupId,
        name: "Default",
        keys,
        createdBy: context.user.id,
      });

      return zg;
    });

    return created;
  });
