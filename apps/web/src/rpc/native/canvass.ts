import { and, asc, eq, gt } from "@turf-tools/db";
import { canvassEvents } from "@turf-tools/db/schema";
import { z } from "zod";
import { nativeMut as mut, nativePub as pub } from "../context";

// All entity ids (personId, doorId, buildingId) are the import pipeline's
// stable identifiers as carried in the turf data blob — external_id for
// persons, lake address-string ids for doors/buildings (never uuids). They
// flow through the blob to the native app and back here unchanged.
// questionId/responseOptionId are app-side uuids.
//
// Every event is an immutable append to canvass_events. There are two kinds:
//   - "result": the entity's complete current disposition (outcome +
//     responses). It's a full snapshot — current state is the latest result.
//   - "note": freeform, append-only.
// clientEventId (client-generated UUID) dedups retries. createdAt is the
// client field-time; the server stamps receivedAt.

const outcome = z.enum([
  "canvassed",
  "not_home",
  "deceased",
  "hostile",
  "moved",
  "address_not_found",
  "inaccessible",
]);

// One question's answer: selected option ids (single- or multi-select) or
// free text.
const responseValue = z.union([
  z.object({ optionIds: z.array(z.string().uuid()) }),
  z.object({ text: z.string() }),
]);

const resultPayload = z.object({
  kind: z.literal("result"),
  outcome: outcome.nullable(),
  responses: z.record(z.string(), responseValue), // keyed by questionId
});

// Append a result (full disposition snapshot) for a person, door, or building.
export const appendResult = mut
  .input(
    z.object({
      turfId: z.string().uuid(),
      walkId: z.string().uuid().optional(),
      personId: z.string().optional(),
      doorId: z.string().optional(),
      buildingId: z.string().optional(),
      payload: resultPayload,
      createdAt: z.string(),
      canvasserId: z.string().optional(),
      canvasserName: z.string().optional(),
      canvasserPhone: z.string().optional(),
      inputType: z.string().optional(),
      clientEventId: z.string().optional(),
    }),
  )
  .handler(async ({ context, input }) => {
    await context.db
      .insert(canvassEvents)
      .values({
        clientEventId: input.clientEventId,
        turfId: input.turfId,
        walkId: input.walkId,
        canvasserId: input.canvasserId,
        canvasserName: input.canvasserName,
        canvasserPhone: input.canvasserPhone,
        personId: input.personId,
        doorId: input.doorId,
        buildingId: input.buildingId,
        kind: "result",
        payload: input.payload,
        inputType: input.inputType,
        createdAt: new Date(input.createdAt),
      })
      .onConflictDoNothing({ target: canvassEvents.clientEventId });
    return { ok: true };
  });

// Append a note to the event log. Deduped on clientEventId.
export const appendNote = mut
  .input(
    z.object({
      turfId: z.string().uuid(),
      walkId: z.string().uuid().optional(),
      personId: z.string().optional(),
      doorId: z.string().optional(),
      buildingId: z.string().optional(),
      text: z.string().min(1),
      createdAt: z.string(),
      canvasserId: z.string().optional(),
      canvasserName: z.string().optional(),
      canvasserPhone: z.string().optional(),
      inputType: z.string().optional(),
      clientEventId: z.string().optional(),
    }),
  )
  .handler(async ({ context, input }) => {
    await context.db
      .insert(canvassEvents)
      .values({
        clientEventId: input.clientEventId,
        turfId: input.turfId,
        walkId: input.walkId,
        canvasserId: input.canvasserId,
        canvasserName: input.canvasserName,
        canvasserPhone: input.canvasserPhone,
        personId: input.personId,
        doorId: input.doorId,
        buildingId: input.buildingId,
        kind: "note",
        payload: { kind: "note", text: input.text },
        inputType: input.inputType,
        createdAt: new Date(input.createdAt),
      })
      .onConflictDoNothing({ target: canvassEvents.clientEventId });
    return { ok: true };
  });

// Pull events since a cursor. The client stores the returned cursor and
// passes it on the next call to get only new events.
export const pull = pub
  .input(
    z.object({
      turfId: z.string().uuid(),
      cursor: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(500),
    }),
  )
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select()
      .from(canvassEvents)
      .where(and(eq(canvassEvents.turfId, input.turfId), gt(canvassEvents.sequence, input.cursor)))
      .orderBy(asc(canvassEvents.sequence))
      .limit(input.limit);

    const newCursor = rows.length > 0 ? rows[rows.length - 1]!.sequence : input.cursor;

    return { events: rows, cursor: newCursor };
  });
