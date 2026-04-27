import { and, asc, type Db, eq } from "@field-tools/db";
import { campaigns, organizations, segments } from "@field-tools/db/schema";
import { z } from "zod";
import { type Query as QueryShape } from "../lib/filters";
import { boundaryKeyExprFor } from "../lib/key-groups";
import { queryToWhere } from "../lib/query-to-sql";
import { mut, pub } from "./context";

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

// Resolve the user's org slug from the auth context. The data service
// uses it to namespace the persons/buildings tables.
async function loadOrgSlug(context: { db: Db; user: { organizationId: string } }): Promise<string> {
  const rows = await context.db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.organizationId, context.user.organizationId));
  const slug = rows[0]?.slug;
  if (!slug) throw new Error("Organization not found");
  return slug;
}

// Live counts for an arbitrary query — person/door/building totals
// plus a 100-row sample. Takes the query as an explicit argument
// rather than looking it up from a saved segment, because the segment
// editor wants live preview against the in-progress draft, not the
// persisted snapshot.
//
// Builds one SQL statement against the org's persons table that
// returns all four numbers in a single row. The data service is a
// generic executor — see /query/counts in apps/data/main.py.
export const queryCounts = mut
  .input(z.object({ query: z.unknown() }))
  .handler(async ({ context, input }) => {
    const orgSlug = await loadOrgSlug(context);
    const { where, params } = queryToWhere(input.query as QueryShape);
    const persons = `ducklake.main.${orgSlug}_persons_geocoded`;
    // CTE materialised once so the WHERE evaluates a single time
    // even though three subqueries reference it.
    const sql = `
      WITH filtered AS MATERIALIZED (SELECT * FROM ${persons} ${where})
      SELECT
        (SELECT count(*) FROM filtered) AS "personCount",
        (SELECT count(DISTINCT door_id) FROM filtered) AS "doorCount",
        (SELECT count(DISTINCT building_id) FROM filtered) AS "buildingCount",
        (
          SELECT array_agg({
            'external_id': external_id,
            'first_name': first_name,
            'last_name': last_name,
            'address_line_1': address_line_1,
            'address_line_2': address_line_2,
            'city': city,
            'state': state,
            'zip5': zip5,
            'latitude': latitude,
            'longitude': longitude
          })
          FROM (SELECT * FROM filtered LIMIT 100)
        ) AS "samplePeople"
    `;
    const rows = await execute(sql, params);
    const row = rows[0] as {
      personCount: number;
      doorCount: number;
      buildingCount: number;
      // array_agg over an empty input returns null; flatten to [].
      samplePeople: Array<Record<string, unknown>> | null;
    };
    return {
      personCount: row.personCount,
      doorCount: row.doorCount,
      buildingCount: row.buildingCount,
      samplePeople: row.samplePeople ?? [],
    };
  });

// Per-zone aggregation: count of people matching `query` grouped by
// the zone-key column corresponding to `keyGroup`. Used by the zone
// editor's heatmap overlay and the campaign editor.
export const queryCountsByKey = mut
  .input(z.object({ query: z.unknown(), keyGroup: z.string() }))
  .handler(async ({ context, input }) => {
    const orgSlug = await loadOrgSlug(context);
    const { where, params } = queryToWhere(input.query as QueryShape);
    const persons = `ducklake.main.${orgSlug}_persons_geocoded`;
    const groupExpr = boundaryKeyExprFor(input.keyGroup);
    const sql = `
      SELECT
        ${groupExpr} AS key,
        count(DISTINCT door_id) AS doors,
        count(*) AS people
      FROM ${persons}
      ${where}
      GROUP BY ${groupExpr}
    `;
    const rows = await execute(sql, params);
    const counts: Record<string, { doors: number; people: number }> = {};
    for (const r of rows) {
      const key = r.key as string | null;
      if (key == null) continue;
      counts[key] = { doors: Number(r.doors), people: Number(r.people) };
    }
    return { counts };
  });

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

// Note: there's no `queryPoints` oRPC procedure — points come back as
// raw binary, which oRPC's JSON envelope doesn't accommodate without
// base64 (and the per-byte decode that imposes on the main thread).
// The browser hits `POST /api/query-points` directly; that route
// (apps/web/src/routes/api/query-points.ts) handles auth + org
// scoping, builds the SQL, and proxies the binary response.
