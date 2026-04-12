import { eq } from "@field-tools/db";
import {
  canvassNotes,
  canvassResultsBuildings,
  canvassResultsDoors,
  canvassResultsPersons,
} from "@field-tools/db/schema";
import { z } from "zod";
import { mut, pub } from "./context";

// All ids passed in (doorId, buildingId, voterId / personId, surveyQuestionId,
// surveyResponseOptionId) are the global UUIDs assigned by the DuckLake import
// pipeline. They flow through the turf data blob to the native app and back
// here unchanged.
//
// submitPersonResult upserts on (turfId, voterId, userId) — the same canvasser
// syncing the same person overwrites the previous result. Different canvassers
// each keep their own row.
//
// Notes are append-only in a separate table, deduped on (turfId, userId, canvassedAt).

const doorOutcome = z.enum(["address_not_found"]);
const buildingOutcome = z.enum(["inaccessible"]);
const personOutcome = z.enum(["not_home", "deceased", "hostile", "moved"]);

export const submitDoorResult = mut
  .input(
    z.object({
      turfId: z.string().uuid(),
      doorId: z.string().uuid(),
      outcome: doorOutcome,
    }),
  )
  .handler(async ({ context, input }) => {
    await context.db.insert(canvassResultsDoors).values({
      doorId: input.doorId,
      turfId: input.turfId,
      outcome: input.outcome,
      userId: context.user.userId,
    });
    return { ok: true };
  });

export const submitBuildingResult = mut
  .input(
    z.object({
      turfId: z.string().uuid(),
      buildingId: z.string().uuid(),
      outcome: buildingOutcome,
    }),
  )
  .handler(async ({ context, input }) => {
    await context.db.insert(canvassResultsBuildings).values({
      buildingId: input.buildingId,
      turfId: input.turfId,
      outcome: input.outcome,
      userId: context.user.userId,
    });
    return { ok: true };
  });

// Submit a per-person canvass result. Upserts on (turfId, voterId, userId).
export const submitPersonResult = mut
  .input(
    z.object({
      turfId: z.string().uuid(),
      buildingId: z.string().uuid(),
      doorId: z.string().uuid(),
      personId: z.string(),
      inputType: z.string().optional(),
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
    // Explicitly null all result fields so the upsert clears previous values.
    const row = {
      userId: context.user.userId,
      voterId: input.personId,
      buildingId: input.buildingId,
      doorId: input.doorId,
      turfId: input.turfId,
      inputType: input.inputType ?? "mobile",
      canvassedAt: new Date(),
      outcome: null as string | null,
      surveyQuestionId: null as string | null,
      surveyResponseOptionId: null as string | null,
      empty: false,
    };

    switch (input.payload.kind) {
      case "survey":
        row.surveyQuestionId = input.payload.surveyQuestionId;
        row.surveyResponseOptionId = input.payload.surveyResponseOptionId;
        break;
      case "outcome":
        row.outcome = input.payload.outcome;
        break;
      case "empty":
        row.empty = true;
        break;
    }

    const { turfId: _t, userId: _u, voterId: _v, ...updateFields } = row;
    await context.db
      .insert(canvassResultsPersons)
      .values(row)
      .onConflictDoUpdate({
        target: [
          canvassResultsPersons.turfId,
          canvassResultsPersons.voterId,
          canvassResultsPersons.userId,
        ],
        set: updateFields,
      });
    return { ok: true };
  });

// Submit a note. Append-only — deduped on (turfId, userId, canvassedAt).
export const submitNote = mut
  .input(
    z.object({
      turfId: z.string().uuid(),
      personId: z.string().optional(),
      doorId: z.string().uuid().optional(),
      buildingId: z.string().uuid().optional(),
      text: z.string().min(1),
      canvassedAt: z.string(),
    }),
  )
  .handler(async ({ context, input }) => {
    await context.db
      .insert(canvassNotes)
      .values({
        turfId: input.turfId,
        userId: context.user.userId,
        personId: input.personId,
        doorId: input.doorId,
        buildingId: input.buildingId,
        text: input.text,
        canvassedAt: new Date(input.canvassedAt),
      })
      .onConflictDoNothing({
        target: [canvassNotes.turfId, canvassNotes.userId, canvassNotes.canvassedAt],
      });
    return { ok: true };
  });

// Hydrate a device's local cache with all canvass results for a turf.
export const listForTurf = pub
  .input(z.object({ turfId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const doors = await context.db
      .select()
      .from(canvassResultsDoors)
      .where(eq(canvassResultsDoors.turfId, input.turfId))
      .orderBy(canvassResultsDoors.canvassedAt);

    const buildings = await context.db
      .select()
      .from(canvassResultsBuildings)
      .where(eq(canvassResultsBuildings.turfId, input.turfId))
      .orderBy(canvassResultsBuildings.canvassedAt);

    const persons = await context.db
      .select()
      .from(canvassResultsPersons)
      .where(eq(canvassResultsPersons.turfId, input.turfId))
      .orderBy(canvassResultsPersons.canvassedAt);

    const notes = await context.db
      .select()
      .from(canvassNotes)
      .where(eq(canvassNotes.turfId, input.turfId))
      .orderBy(canvassNotes.canvassedAt);

    return { doors, buildings, persons, notes };
  });
