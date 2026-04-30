import { and, asc, type Db, eq } from "@field-tools/db";
import {
  campaigns,
  organizations,
  segments as segmentsTable,
  zoneGroups,
  zones,
} from "@field-tools/db/schema";
import { z } from "zod";
import { criteriaToWhere } from "../lib/criteria-to-sql";
import { type Criteria } from "../lib/filters";
import { boundaryKeyExprFor } from "../lib/key-groups";
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
          createdBy: context.user.userId,
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
    // 1. Pull the segment's criteria, scoped to org.
    const segmentRows = await context.db
      .select({ criteria: segmentsTable.criteria })
      .from(segmentsTable)
      .where(
        and(
          eq(segmentsTable.segmentId, input.segmentId),
          eq(segmentsTable.organizationId, context.user.organizationId),
        ),
      );
    const segment = segmentRows[0];
    if (!segment) throw new Error("Segment not found");

    // 2. Run a DISTINCT-keys query against DuckLake and collect the
    // results into the zone's `keys` array.
    const orgSlug = await loadOrgSlug(context);
    const persons = `ducklake.main.${orgSlug}_persons_geocoded`;
    const groupExpr = boundaryKeyExprFor(input.keyGroup);
    const { where, params } = criteriaToWhere(segment.criteria as Criteria);
    const sql = `
      SELECT DISTINCT ${groupExpr} AS key
      FROM ${persons}
      ${where}
    `;
    const rows = await execute(sql, params);
    const keys = rows
      .map((r) => r.key as string | null)
      .filter((k): k is string => typeof k === "string" && k.length > 0)
      .sort();

    // 3. Insert zone group + zone in one transaction so a partial
    // failure can't leave a zone-less group behind.
    const created = await context.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(zoneGroups)
        .values({
          organizationId: context.user.organizationId,
          name: input.name,
          keyGroup: input.keyGroup,
          createdBy: context.user.userId,
        })
        .returning(zoneGroupSelect);
      const zg = inserted[0]!;

      await tx.insert(zones).values({
        zoneGroupId: zg.zoneGroupId,
        name: "Default",
        keys,
        createdBy: context.user.userId,
      });

      return zg;
    });

    return created;
  });

// Local copies of segments.ts's helpers — small enough that
// duplicating beats lifting them into a shared module right now.
async function loadOrgSlug(context: { db: Db; user: { organizationId: string } }): Promise<string> {
  const rows = await context.db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.organizationId, context.user.organizationId));
  const slug = rows[0]?.slug;
  if (!slug) throw new Error("Organization not found");
  return slug;
}

async function execute(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${import.meta.env.VITE_DATA_URL}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`/query failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
  return body.rows;
}
