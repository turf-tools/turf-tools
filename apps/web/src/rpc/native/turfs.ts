import { and, eq } from "@turf-tools/db";
import { campaigns, turfData, turfs } from "@turf-tools/db/schema";
import type { TurfData } from "@turf-tools/db/schema";
import { z } from "zod";
import { publish } from "~/lib/server/live";
import { recordScan } from "~/lib/server/scans";
import { nativePub as pub } from "../context";

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
// Admin tooling reaches turfs via `admin/turfs.listForOrg` instead.
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
// Filtered to `status = 'active'` because turf codes can repeat
// across archived rows (the unique constraint is partial). Archived
// turfs no longer honor their codes — canvassers can't access them.
//
// An unattributed resolution (device has no canvasser yet, so the bind
// is about to park behind the identity sheet) is also the handoff
// signal: it records the scan so the lead's board flips to "pending"
// the moment the canvasser commits. Attributed devices skip the signal
// entirely — their walk lands a second later, and a pending state in
// between would only flash. The signal ends by walk arrival or decay,
// never a cancel: a lingering spinner is safer than a vanished one when
// the goal is preventing duplicate handouts. (getById, the
// relaunch-rebind path, deliberately doesn't signal.)
export const getByCode = pub
  .input(z.object({ code: z.string().min(1), attributed: z.boolean().optional() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select({
        ...turfSelect,
        campaignId: turfs.campaignId,
        organizationId: campaigns.organizationId,
      })
      .from(turfs)
      .innerJoin(campaigns, eq(turfs.campaignId, campaigns.campaignId))
      .where(and(eq(turfs.turfCode, input.code), eq(turfs.status, "active")));
    const row = rows[0];
    if (!row) return null;
    if (input.attributed === false) {
      recordScan(row.turfId, row.organizationId, row.campaignId);
      publish(row.organizationId);
    }
    const { organizationId: _, campaignId: __, ...turf } = row;
    return turf;
  });

// Fetch the buildings → doors → persons payload for a single turf.
// Capability-based on the turfId.
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
