import { and, asc, eq, gt } from "@field-tools/db";
import { canvassEvents } from "@field-tools/db/schema";
import { z } from "zod";
import { mut, pub } from "./context";

// All ids passed in (doorId, buildingId, personId, surveyQuestionId,
// surveyResponseOptionId) are the global UUIDs assigned by the DuckLake import
// pipeline. They flow through the turf data blob to the native app and back
// here unchanged.
//
// Every result is an immutable append to canvass_events. "Current state" for
// an entity = latest event by sequence. The clientEventId (client-generated
// UUID) is used for dedup on retry.

const personOutcome = z.enum(["not_home", "deceased", "hostile", "moved"]);
const doorOutcome = z.enum(["address_not_found"]);
const buildingOutcome = z.enum(["inaccessible"]);

export const appendDoorResult = mut
  .input(
    z.object({
      turfId: z.string().uuid(),
      doorId: z.string().uuid(),
      outcome: doorOutcome,
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
        userId: context.user.userId,
        doorId: input.doorId,
        type: "outcome",
        payload: { kind: "outcome", outcome: input.outcome },
        inputType: input.inputType,
      })
      .onConflictDoNothing({ target: canvassEvents.clientEventId });
    return { ok: true };
  });

export const appendBuildingResult = mut
  .input(
    z.object({
      turfId: z.string().uuid(),
      buildingId: z.string().uuid(),
      outcome: buildingOutcome,
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
        userId: context.user.userId,
        buildingId: input.buildingId,
        type: "outcome",
        payload: { kind: "outcome", outcome: input.outcome },
        inputType: input.inputType,
      })
      .onConflictDoNothing({ target: canvassEvents.clientEventId });
    return { ok: true };
  });

// Append a per-person canvass result to the event log.
export const appendPersonResult = mut
  .input(
    z.object({
      turfId: z.string().uuid(),
      buildingId: z.string().uuid().optional(),
      doorId: z.string().uuid().optional(),
      personId: z.string(),
      inputType: z.string().optional(),
      clientEventId: z.string().optional(),
      payload: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("survey"),
          surveyQuestionId: z.string().uuid(),
          surveyResponseOptionId: z.string().uuid(),
        }),
        z.object({
          kind: z.literal("outcome"),
          outcome: personOutcome,
        }),
        z.object({
          kind: z.literal("empty"),
        }),
      ]),
    }),
  )
  .handler(async ({ context, input }) => {
    await context.db
      .insert(canvassEvents)
      .values({
        clientEventId: input.clientEventId,
        turfId: input.turfId,
        userId: context.user.userId,
        personId: input.personId,
        type: input.payload.kind,
        payload: input.payload,
        inputType: input.inputType,
      })
      .onConflictDoNothing({ target: canvassEvents.clientEventId });
    return { ok: true };
  });

// Append a note to the event log. Deduped on clientEventId.
export const appendNote = mut
  .input(
    z.object({
      turfId: z.string().uuid(),
      personId: z.string().optional(),
      doorId: z.string().uuid().optional(),
      buildingId: z.string().uuid().optional(),
      text: z.string().min(1),
      canvassedAt: z.string(),
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
        userId: context.user.userId,
        personId: input.personId,
        doorId: input.doorId,
        buildingId: input.buildingId,
        type: "note",
        payload: { kind: "note", text: input.text, canvassedAt: input.canvassedAt },
        inputType: input.inputType,
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
