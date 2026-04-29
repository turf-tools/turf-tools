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
import type {
  TurfData,
  TurfDataBuilding,
  TurfDataDoor,
  TurfDataPerson,
} from "@field-tools/db/schema";
import { z } from "zod";
import { criteriaToWhere } from "../lib/criteria-to-sql";
import { type Criteria } from "../lib/filters";
import { mut, pub } from "./context";
import { applyKeyFilter, execute, loadOrgSlug } from "./segments";

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
export const getByCode = pub
  .input(z.object({ code: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(turfSelect)
      .from(turfs)
      .where(eq(turfs.turfCode, input.code));
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

    // 5. Run the segment criteria against persons_geocoded joined
    // with buildings_geocoded. Per-person fields stay on `p` (id,
    // name, unit, other_properties); canonical building values
    // (lat/lng + address) come from `b` so the blob matches what
    // the rest of the pipeline considers canonical for that
    // building. `other_properties` passes through verbatim — the
    // native app unpacks the keys it needs (party, gender,
    // date_of_birth, etc.) so adding new voter-file fields
    // upstream doesn't require a blob schema change here.
    const orgSlug = await loadOrgSlug(context);
    const { where, params } = applyKeyFilter(criteriaToWhere(segmentCriteria), {
      keyGroup,
      keys: zone.keys,
    });
    const personsTable = `ducklake.main.${orgSlug}_persons_geocoded`;
    const buildingsTable = `ducklake.main.${orgSlug}_buildings_geocoded`;
    const sql = `
      SELECT
        p.external_id            AS external_id,
        p.first_name             AS first_name,
        p.last_name              AS last_name,
        p.address_line_2         AS unit,
        p.other_properties       AS other_properties,
        p.building_id            AS building_id,
        p.door_id                AS door_id,
        b.latitude               AS latitude,
        b.longitude              AS longitude,
        b.address_line_1         AS street,
        b.city                   AS city,
        b.state                  AS state,
        b.zip5                   AS zip5
      FROM (SELECT * FROM ${personsTable} ${where}) p
      JOIN ${buildingsTable} b ON b.building_id = p.building_id
    `;
    const personRows = (await execute(sql, params)) as Array<{
      external_id: string;
      first_name: string | null;
      last_name: string | null;
      unit: string | null;
      // DuckDB returns JSON columns as strings over the data app's
      // `/query` HTTP endpoint; we parse once per row below.
      other_properties: string | Record<string, string | null> | null;
      building_id: string;
      door_id: string;
      latitude: number | null;
      longitude: number | null;
      street: string | null;
      city: string | null;
      state: string | null;
      zip5: string | null;
    }>;

    // 6. Group persons by building / door. Building fields are
    // canonical from `_buildings_geocoded`, repeated on every row
    // sharing a building_id — we just take the first occurrence.
    type BuildingAcc = {
      buildingId: string;
      latitude: number | null;
      longitude: number | null;
      address: TurfDataBuilding["address"];
      doors: Map<string, { unit: string | null; persons: TurfDataPerson[] }>;
    };
    const buildingAcc = new Map<string, BuildingAcc>();
    for (const r of personRows) {
      let b = buildingAcc.get(r.building_id);
      if (!b) {
        b = {
          buildingId: r.building_id,
          latitude: r.latitude,
          longitude: r.longitude,
          address: {
            street: r.street,
            city: r.city,
            state: r.state,
            zip: r.zip5,
          },
          doors: new Map(),
        };
        buildingAcc.set(r.building_id, b);
      }
      let d = b.doors.get(r.door_id);
      if (!d) {
        d = { unit: r.unit, persons: [] };
        b.doors.set(r.door_id, d);
      }
      d.persons.push({
        personId: r.external_id,
        firstName: r.first_name,
        lastName: r.last_name,
        otherProperties:
          typeof r.other_properties === "string"
            ? (JSON.parse(r.other_properties) as Record<string, string | null>)
            : (r.other_properties ?? {}),
      });
    }

    // 7. Assign each building to the first draft polygon that
    // contains its centroid. Buildings outside every polygon are
    // dropped from the publish (they're in the segment ∩ zone but
    // not in any cut). First-match-wins so an overlap doesn't
    // double-count buildings across turfs.
    const draftBuckets = drafts.map(() => new Set<string>());
    for (const b of buildingAcc.values()) {
      if (b.latitude == null || b.longitude == null) continue;
      const point: [number, number] = [b.longitude, b.latitude];
      for (let i = 0; i < drafts.length; i++) {
        const ring = drafts[i]!.geometry.coordinates[0];
        if (!ring) continue;
        if (pointInRing(point, ring)) {
          draftBuckets[i]!.add(b.buildingId);
          break;
        }
      }
    }

    // 8. Materialize the per-turf TurfData blobs and a parallel
    // counts array so the insert step has everything it needs.
    const turfPayloads = drafts.map((draft, i) => {
      const buildingIds = draftBuckets[i]!;
      const buildings: TurfDataBuilding[] = [];
      let doorCount = 0;
      let personCount = 0;
      for (const id of buildingIds) {
        const b = buildingAcc.get(id);
        if (!b) continue;
        const doors: TurfDataDoor[] = [];
        for (const [doorId, d] of b.doors) {
          doors.push({ doorId, unit: d.unit, persons: d.persons });
          doorCount += 1;
          personCount += d.persons.length;
        }
        buildings.push({
          buildingId: b.buildingId,
          latitude: b.latitude,
          longitude: b.longitude,
          address: b.address,
          doors,
        });
      }
      return {
        draft,
        buildings,
        doorCount,
        personCount,
      };
    });

    // 9. Insert turfs + turf_data rows in a single transaction with
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

// Standard ray-casting point-in-polygon test on a closed ring (per
// GeoJSON, the first and last points are equal). The duplicate
// doesn't affect the result — we iterate edges, and the edge from
// the last unique vertex back to the first is included naturally
// either way.
function pointInRing(point: [number, number], ring: number[][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const xi = a[0]!;
    const yi = a[1]!;
    const xj = b[0]!;
    const yj = b[1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

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
