import { and, eq } from "@field-tools/db";
import { turfs } from "@field-tools/db/schema";
import { z } from "zod";
import { pub } from "./context";

// List turfs assigned to the current user. Returns a minimal shape suitable
// for a list screen — the full blob lives at dataUrl and is fetched separately.
export const getMine = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  const rows = await context.db
    .select({
      turfId: turfs.turfId,
      name: turfs.name,
      dataUrl: turfs.dataUrl,
      doors: turfs.doors,
      people: turfs.people,
      geometry: turfs.geometry,
    })
    .from(turfs)
    .where(eq(turfs.assignedTo, context.user.userId));
  return rows;
});

// Fetch a single turf by id. The caller still needs to hit dataUrl for the
// building/door/person hierarchy.
export const get = pub
  .input(z.object({ turfId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select({
        turfId: turfs.turfId,
        name: turfs.name,
        dataUrl: turfs.dataUrl,
        doors: turfs.doors,
        people: turfs.people,
        geometry: turfs.geometry,
        scriptId: turfs.scriptId,
        assignedTo: turfs.assignedTo,
      })
      .from(turfs)
      .where(and(eq(turfs.turfId, input.turfId), eq(turfs.assignedTo, context.user.userId)));
    return rows[0] ?? null;
  });
