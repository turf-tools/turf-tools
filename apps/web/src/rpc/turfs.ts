import { and, asc, eq, inArray, sql } from "@field-tools/db";
import {
  campaigns,
  segments,
  turfData,
  turfDrafts,
  turfs,
  zoneGroups,
  zones,
} from "@field-tools/db/schema";
import type { TurfData, TurfDataBuilding } from "@field-tools/db/schema";
import { z } from "zod";
import { dataPostJson } from "~/lib/server/data-proxy";
import { type Criteria } from "../lib/filters";
import { mut, pub } from "./context";
import { loadOrgSlug } from "./segments";

// Shared select shape for turf list/detail responses. The
// buildings/doors/persons payload lives in `turf_data` and is
// fetched separately via the dedicated RPC — list responses stay
// light by design.
const turfSelect = {
  turfId: turfs.turfId,
  name: turfs.name,
  turfCode: turfs.turfCode,
  doorCount: turfs.doorCount,
  personCount: turfs.personCount,
  geometry: turfs.geometry,
  scriptId: turfs.scriptId,
};

// Capability-based fetch — possessing the turfId is the access.
// No org check: a canvasser may belong to no org (or to a different
// one) but still hold turf ids handed out by an admin. Same model
// as a sharing link in MiniVAN / Google Docs. Brute-forcing UUIDs
// is infeasible; admins distribute ids/codes to whoever should have
// access.
export const getById = pub
  .input(z.object({ turfId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(turfSelect)
      .from(turfs)
      .where(eq(turfs.turfId, input.turfId));
    return rows[0] ?? null;
  });

// Resolve a turf by its short code (typed in or scanned from a QR).
// Capability-based — same reasoning as `getById`. Codes are
// generated server-side at publish time with enough entropy to
// resist brute-force at any reasonable rate limit.
//
// Filtered to `status = 'active'` because turf codes can repeat
// across archived rows (the unique constraint is partial). Archived
// turfs no longer honor their codes — canvassers can't access them.
export const getByCode = pub
  .input(z.object({ code: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(turfSelect)
      .from(turfs)
      .where(and(eq(turfs.turfCode, input.code), eq(turfs.status, "active")));
    return rows[0] ?? null;
  });

// Admin-scoped turf list: all turfs within the current user's org,
// optionally filtered by campaign. Joins through `campaigns` since
// turfs carry a campaignId (not organizationId) directly. The
// `segments` and `zones` joins are LEFT joins because the schema
// only enforces an FK on `campaignId` — a turf can outlive its
// source segment or zone (forever-snapshot policy), and we still
// want the row to render with the name missing rather than
// disappearing from the list.
export const listForOrg = pub
  .input(z.object({ campaignId: z.string().uuid().optional() }).optional())
  .handler(async ({ context, input }) => {
    const orgFilter = eq(campaigns.organizationId, context.user.organizationId);
    const where = input?.campaignId
      ? and(orgFilter, eq(turfs.campaignId, input.campaignId))
      : orgFilter;
    const rows = await context.db
      .select({
        turfId: turfs.turfId,
        name: turfs.name,
        turfCode: turfs.turfCode,
        doorCount: turfs.doorCount,
        personCount: turfs.personCount,
        campaignId: turfs.campaignId,
        campaignName: campaigns.name,
        segmentId: turfs.segmentId,
        segmentName: segments.name,
        zoneId: turfs.zoneId,
        zoneName: zones.name,
        createdAt: turfs.createdAt,
      })
      .from(turfs)
      .innerJoin(campaigns, eq(turfs.campaignId, campaigns.campaignId))
      .leftJoin(segments, eq(turfs.segmentId, segments.segmentId))
      .leftJoin(zones, eq(turfs.zoneId, zones.zoneId))
      .where(where)
      .orderBy(asc(turfs.createdAt));
    return rows;
  });

// Total published-turf count for a campaign. Used by the campaign delete
// dialog to refuse deletion when turfs exist.
export const countForCampaign = pub
  .input(z.object({ campaignId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select({ count: sql<number>`count(*)::int` })
      .from(turfs)
      .where(eq(turfs.campaignId, input.campaignId));
    return { count: rows[0]?.count ?? 0 };
  });

// Per-zone turf counts for a campaign — drafts (work-in-progress in the
// cutter) and published (rows in `turfs`). Drives the campaign editor's
// at-a-glance progress indicators.
export const statsForCampaign = pub
  .input(z.object({ campaignId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const draftRows = await context.db
      .select({ zoneId: turfDrafts.zoneId, count: sql<number>`count(*)::int` })
      .from(turfDrafts)
      .where(eq(turfDrafts.campaignId, input.campaignId))
      .groupBy(turfDrafts.zoneId);
    const turfRows = await context.db
      .select({ zoneId: turfs.zoneId, count: sql<number>`count(*)::int` })
      .from(turfs)
      .where(eq(turfs.campaignId, input.campaignId))
      .groupBy(turfs.zoneId);
    const stats: Record<string, { drafts: number; published: number }> = {};
    for (const r of draftRows) stats[r.zoneId] = { drafts: r.count, published: 0 };
    for (const r of turfRows) {
      const cur = stats[r.zoneId] ?? { drafts: 0, published: 0 };
      cur.published = r.count;
      stats[r.zoneId] = cur;
    }
    return stats;
  });

// Fetch the buildings → doors → persons payload for a single turf.
// Capability-based, same reasoning as `getById`.
export const getData = pub
  .input(z.object({ turfId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select({ data: turfData.data })
      .from(turfData)
      .where(eq(turfData.turfId, input.turfId));
    if (rows.length === 0) return null;
    return rows[0]!.data as TurfData;
  });

// Publish all drafts for a `(campaign, segment, zone)` scope as immutable
// turfs. Each draft polygon becomes a turf row + a turf_data row
// containing the buildings → doors → persons hierarchy of the
// segment ∩ zone ∩ polygon intersection. Drafts are *not* cleared
// after publish — re-publishing a zone appends a new batch of turfs
// (stale-tracking of older batches is a follow-up).
//
// Server-side computation: we run the segment criteria against
// `_persons_geocoded`, point-in-polygon-test each building's
// centroid against each draft (first-match-wins so overlapping
// polygons partition the buildings deterministically), then
// assemble the per-turf blob.
export const publish = mut
  .input(
    z.object({
      campaignId: z.string().uuid(),
      zoneId: z.string().uuid(),
    }),
  )
  .handler(async ({ context, input }) => {
    // 1. Resolve campaign — we need its segment, script, and zone
    // group bindings, all of which must be set for a publish to be
    // meaningful.
    const campaignRow = await context.db
      .select({
        segmentId: campaigns.segmentId,
        scriptId: campaigns.scriptId,
        zoneGroupId: campaigns.zoneGroupId,
      })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.campaignId, input.campaignId),
          eq(campaigns.organizationId, context.user.organizationId),
        ),
      );
    if (campaignRow.length === 0) throw new Error("Campaign not found");
    const { segmentId, scriptId, zoneGroupId } = campaignRow[0]!;
    if (!segmentId || !scriptId || !zoneGroupId) {
      throw new Error("Campaign must have a segment, script, and zone group bound to publish");
    }

    // 2. Resolve zone (and verify it belongs to the campaign's
    // zoneGroup — turfs are forever snapshots, so we want to be
    // sure we're cutting from the right scope).
    const zoneRow = await context.db
      .select({ name: zones.name, keys: zones.keys })
      .from(zones)
      .where(and(eq(zones.zoneId, input.zoneId), eq(zones.zoneGroupId, zoneGroupId)));
    if (zoneRow.length === 0) {
      throw new Error("Zone not found in campaign's zone group");
    }
    const zone = zoneRow[0]!;

    // 3. Resolve segment (need its criteria) and zone group (need its
    // keyGroup label for the boundary-key filter).
    const segmentRow = await context.db
      .select({ criteria: segments.criteria })
      .from(segments)
      .where(eq(segments.segmentId, segmentId));
    if (segmentRow.length === 0) throw new Error("Segment not found");
    const segmentCriteria = segmentRow[0]!.criteria as Criteria | null;
    if (!segmentCriteria) throw new Error("Segment has no criteria defined");

    const zoneGroupRow = await context.db
      .select({ keyGroup: zoneGroups.keyGroup })
      .from(zoneGroups)
      .where(eq(zoneGroups.zoneGroupId, zoneGroupId));
    if (zoneGroupRow.length === 0) throw new Error("Zone group not found");
    const keyGroup = zoneGroupRow[0]!.keyGroup;

    // 4. Fetch drafts. Sort by `sortOrder` so the user's intent
    // (numbering, overlap precedence) is preserved.
    const drafts = await context.db
      .select({
        turfDraftId: turfDrafts.turfDraftId,
        geometry: turfDrafts.geometry,
        name: turfDrafts.name,
        sortOrder: turfDrafts.sortOrder,
      })
      .from(turfDrafts)
      .where(and(eq(turfDrafts.campaignId, input.campaignId), eq(turfDrafts.zoneId, input.zoneId)))
      .orderBy(asc(turfDrafts.sortOrder));
    if (drafts.length === 0) throw new Error("No drafts to publish");

    // 5. Hand off the spatial join to the data app. Web sends the
    // drafts + criteria + keyFilter; data does the filtered persons
    // ∩ buildings ∩ polygons join and returns each draft's
    // structured `buildings → doors → persons` payload plus
    // pre-aggregated counts.
    const orgSlug = await loadOrgSlug(context);
    const built = await dataPostJson<{
      turfs: Array<{
        name: string | null;
        sortOrder: number;
        geometry: { type: "Polygon"; coordinates: number[][][] };
        doorCount: number;
        personCount: number;
        buildings: TurfDataBuilding[];
      }>;
    }>("/turfs/build", {
      drafts: drafts.map((d) => ({
        name: d.name,
        sortOrder: d.sortOrder,
        geometry: d.geometry,
      })),
      criteria: segmentCriteria,
      keyFilter: { keyGroup, keys: zone.keys },
      orgSlug,
    });

    // 6. Pair each returned turf with the corresponding draft (same
    // input order). Drafts that produced no matched buildings still
    // get a turf row with empty `buildings` — they're a valid (if
    // empty) cut.
    const turfPayloads = drafts.map((draft, i) => {
      const t = built.turfs[i]!;
      return {
        draft,
        buildings: t.buildings,
        doorCount: t.doorCount,
        personCount: t.personCount,
      };
    });

    // 7. Insert turfs + turf_data rows in a single transaction with
    // bulk inserts — collapses ~3 round trips per draft into ~3 total
    // regardless of count. Pre-generate turfIds and turfCodes so each
    // draft can be linked across both inserts without relying on
    // RETURNING order.
    const turfIds = turfPayloads.map(() => crypto.randomUUID());
    const turfCodes = turfPayloads.map(() => genTurfCode());
    const created: Array<{ turfId: string; name: string; turfCode: string }> = [];
    await context.db.transaction(async (tx) => {
      // Resolve any code collisions in bulk. 6-char Crockford base-32
      // collisions are essentially nonexistent, so we cap at a small
      // retry budget.
      for (let attempt = 0; attempt < 10; attempt++) {
        const collisions = await tx
          .select({ turfCode: turfs.turfCode })
          .from(turfs)
          .where(inArray(turfs.turfCode, turfCodes));
        if (collisions.length === 0) break;
        const colliding = new Set(collisions.map((c) => c.turfCode));
        for (let i = 0; i < turfCodes.length; i++) {
          if (colliding.has(turfCodes[i]!)) turfCodes[i] = genTurfCode();
        }
        if (attempt === 9) {
          throw new Error("Could not generate unique turf codes after 10 attempts");
        }
      }

      const turfRows = turfPayloads.map((p, i) => ({
        turfId: turfIds[i]!,
        campaignId: input.campaignId,
        segmentId,
        zoneId: input.zoneId,
        zoneGroupId,
        scriptId,
        name: p.draft.name ?? `Turf ${i + 1}`,
        turfCode: turfCodes[i]!,
        geometry: p.draft.geometry,
        doorCount: p.doorCount,
        personCount: p.personCount,
        createdBy: context.user.userId,
      }));
      await tx.insert(turfs).values(turfRows);

      const dataRows = turfPayloads.map((p, i) => ({
        turfId: turfIds[i]!,
        data: {
          turfId: turfIds[i]!,
          turfCode: turfCodes[i]!,
          name: turfRows[i]!.name,
          geometry: p.draft.geometry,
          buildings: p.buildings,
        } satisfies TurfData,
      }));
      await tx.insert(turfData).values(dataRows);

      for (let i = 0; i < turfPayloads.length; i++) {
        created.push({
          turfId: turfIds[i]!,
          name: turfRows[i]!.name,
          turfCode: turfCodes[i]!,
        });
      }
    });

    return {
      created,
      summary: {
        turfCount: created.length,
        doorCount: turfPayloads.reduce((acc, p) => acc + p.doorCount, 0),
        personCount: turfPayloads.reduce((acc, p) => acc + p.personCount, 0),
      },
    };
  });

// 8-digit numeric — chosen for phone/voice transmission ergonomics:
// a lead reading a code to a canvasser only has to recite digits
// (no letter/number ambiguity, no B/D/M/N confusion). 10^8 = 100M
// possibilities; at ~1000s of turfs per org the birthday-collision
// risk stays under 1%, with a unique-constraint retry catching the
// rare hit anyway.
const TURFCODE_ALPHABET = "0123456789";
function genTurfCode(len = 8): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += TURFCODE_ALPHABET[Math.floor(Math.random() * TURFCODE_ALPHABET.length)];
  }
  return s;
}
