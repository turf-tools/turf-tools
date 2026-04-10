import { and, eq } from "@field-tools/db";
import { turfs } from "@field-tools/db/schema";
import { z } from "zod";
import { pub } from "./context";

// Shared select shape for turf list/detail responses.
const turfSelect = {
  turfId: turfs.turfId,
  name: turfs.name,
  listCode: turfs.listCode,
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

// Resolve a turf by its short list code (typed in or scanned from a QR).
// Returns null if no turf with that code exists or if it's not assigned to
// the current user.
export const getByCode = pub
  .input(z.object({ code: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(turfSelect)
      .from(turfs)
      .where(and(eq(turfs.listCode, input.code), eq(turfs.assignedTo, context.user.userId)));
    return rows[0] ?? null;
  });
