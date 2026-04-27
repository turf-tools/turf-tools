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

// Optional spatial scope passed to the query procedures: clips
// matches to people whose boundary-key falls in `keys`. Mirrors the
// shape `/api/query-points` already accepts, so the same primitive
// covers JSON aggregations and the binary points stream.
const keyFilterSchema = z
  .object({
    keyGroup: z.string(),
    keys: z.array(z.string()),
  })
  .optional();

// Composes the segment WHERE clause with an optional key-set filter.
// Empty `keys` short-circuits to `1=0` so the query returns no rows
// rather than emitting invalid `IN ()` SQL.
function applyKeyFilter(
  base: { where: string; params: unknown[] },
  keyFilter: z.infer<typeof keyFilterSchema>,
): { where: string; params: unknown[] } {
  if (!keyFilter) return base;
  if (keyFilter.keys.length === 0) {
    return {
      where: base.where ? `${base.where} AND 1=0` : "WHERE 1=0",
      params: base.params,
    };
  }
  const expr = boundaryKeyExprFor(keyFilter.keyGroup);
  const placeholders = keyFilter.keys.map(() => "?").join(", ");
  const clause = `${expr} IN (${placeholders})`;
  return {
    where: base.where ? `${base.where} AND ${clause}` : `WHERE ${clause}`,
    params: [...base.params, ...keyFilter.keys],
  };
}

// Live counts for an arbitrary query — person/door/building totals
// plus a 100-row sample. Takes the query as an explicit argument
// rather than looking it up from a saved segment, because the segment
// editor wants live preview against the in-progress draft, not the
// persisted snapshot.
//
// `keyFilter` optionally clips the result to people whose boundary-
// key falls in the supplied set. Used by the campaign editor when it
// wants segment ∩ zone-group totals; segment editor leaves it
// unset.
export const queryCounts = mut
  .input(z.object({ query: z.unknown(), keyFilter: keyFilterSchema }))
  .handler(async ({ context, input }) => {
    const orgSlug = await loadOrgSlug(context);
    const { where, params } = applyKeyFilter(
      queryToWhere(input.query as QueryShape),
      input.keyFilter,
    );
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
//
// `keyFilter` optionally clips the result to a subset of keys (e.g.
// only the keys belonging to the campaign's zone group). Without it,
// the query groups across every key the persons table contains.
export const queryCountsByKey = mut
  .input(z.object({ query: z.unknown(), keyGroup: z.string(), keyFilter: keyFilterSchema }))
  .handler(async ({ context, input }) => {
    const orgSlug = await loadOrgSlug(context);
    const { where, params } = applyKeyFilter(
      queryToWhere(input.query as QueryShape),
      input.keyFilter,
    );
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

// Per-building aggregation: one row per building that contains at
// least one matching person, with door + person counts and the
// building's centroid. Used by the turf cutter to render buildings
// scoped to segment ∩ zone, with enough detail (building id, per-
// building doors/people) to compute "what's inside this drawn
// polygon" client-side.
//
// Returns JSON rather than the binary `/api/query-points` because
// rows carry strings (UUIDs) and integers alongside floats — mixing
// types in a binary frame would need length-prefixing and layout
// metadata that JSON gives for free, and per-zone payloads stay
// small enough that the wire-format efficiency doesn't matter.
export const queryBuildings = mut
  .input(z.object({ query: z.unknown(), keyFilter: keyFilterSchema }))
  .handler(async ({ context, input }) => {
    const orgSlug = await loadOrgSlug(context);
    const { where, params } = applyKeyFilter(
      queryToWhere(input.query as QueryShape),
      input.keyFilter,
    );
    const persons = `ducklake.main.${orgSlug}_persons_geocoded`;
    const buildings = `ducklake.main.${orgSlug}_buildings_geocoded`;
    // The segment WHERE + keyFilter is applied INSIDE a subquery so
    // its unqualified column refs (e.g. `zip5`) only see persons.
    // Without the subquery, columns that exist on both buildings and
    // persons (zip5, address fields, etc.) would be ambiguous in the
    // outer JOIN's WHERE.
    const sql = `
      SELECT
        b.building_id              AS "buildingId",
        b.longitude,
        b.latitude,
        count(DISTINCT fp.door_id) AS "doorCount",
        count(*)                   AS "personCount"
      FROM ${buildings} b
      JOIN (SELECT * FROM ${persons} ${where}) fp
        ON fp.building_id = b.building_id
      GROUP BY b.building_id, b.longitude, b.latitude
    `;
    const rows = await execute(sql, params);
    return {
      buildings: rows as Array<{
        buildingId: string;
        longitude: number;
        latitude: number;
        doorCount: number;
        personCount: number;
      }>,
    };
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
