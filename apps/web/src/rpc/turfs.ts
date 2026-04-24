import { and, asc, eq } from "@field-tools/db";
import { segments, tracks, turfs } from "@field-tools/db/schema";
import { z } from "zod";
import { pub } from "./context";

// Shared select shape for turf list/detail responses.
const turfSelect = {
  turfId: turfs.turfId,
  name: turfs.name,
  turfCode: turfs.turfCode,
  dataUrl: turfs.dataUrl,
  doorCount: turfs.doorCount,
  personCount: turfs.personCount,
  geometry: turfs.geometry,
  scriptId: turfs.scriptId,
  assignedTo: turfs.assignedTo,
};

// List turfs assigned to the current user. Returns a minimal shape suitable
// for a list screen — the full blob lives at dataUrl and is fetched separately.
export const getByUser = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  const rows = await context.db
    .select(turfSelect)
    .from(turfs)
    .where(eq(turfs.assignedTo, context.user.userId));
  return rows;
});

// Fetch a single turf by id. The caller still needs to hit dataUrl for the
// building/door/person hierarchy.
export const getById = pub
  .input(z.object({ turfId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(turfSelect)
      .from(turfs)
      .where(and(eq(turfs.turfId, input.turfId), eq(turfs.assignedTo, context.user.userId)));
    return rows[0] ?? null;
  });

// Resolve a turf by its short code (typed in or scanned from a QR).
// Returns null if no turf with that code exists or if it's not assigned to
// the current user.
export const getByCode = pub
  .input(z.object({ code: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(turfSelect)
      .from(turfs)
      .where(and(eq(turfs.turfCode, input.code), eq(turfs.assignedTo, context.user.userId)));
    return rows[0] ?? null;
  });

// Admin-scoped turf list: all turfs within the current user's org,
// optionally filtered by track. Joins through `tracks` since turfs
// carry a trackId (not organizationId) directly.
export const listForOrg = pub
  .input(z.object({ trackId: z.string().uuid().optional() }).optional())
  .handler(async ({ context, input }) => {
    const orgFilter = eq(tracks.organizationId, context.user.organizationId);
    const where = input?.trackId ? and(orgFilter, eq(turfs.trackId, input.trackId)) : orgFilter;
    const rows = await context.db
      .select({
        turfId: turfs.turfId,
        name: turfs.name,
        turfCode: turfs.turfCode,
        doorCount: turfs.doorCount,
        personCount: turfs.personCount,
        trackId: turfs.trackId,
        trackName: tracks.name,
        segmentId: turfs.segmentId,
        segmentName: segments.name,
        assignedTo: turfs.assignedTo,
        createdAt: turfs.createdAt,
      })
      .from(turfs)
      .innerJoin(tracks, eq(turfs.trackId, tracks.trackId))
      .innerJoin(segments, eq(turfs.segmentId, segments.segmentId))
      .where(where)
      .orderBy(asc(turfs.createdAt));
    return rows;
  });

// Admin-scoped turf lookup: returns a turf if it belongs to the current
// user's organization (via its track), regardless of assignment.
// Used by the admin UI for breadcrumb resolution and detail views.
export const getByIdForOrg = pub
  .input(z.object({ turfId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(turfSelect)
      .from(turfs)
      .innerJoin(tracks, eq(turfs.trackId, tracks.trackId))
      .where(
        and(eq(turfs.turfId, input.turfId), eq(tracks.organizationId, context.user.organizationId)),
      );
    return rows[0] ?? null;
  });
