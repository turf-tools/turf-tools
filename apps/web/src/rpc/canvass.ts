import { eq } from "@field-tools/db";
import {
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
// Every submit procedure is idempotent on `clientMutationId`. The native app
// generates a fresh UUID per mutation at the moment of commit (typically when
// the user navigates away from a screen with a draft). A retried network call
// produces one row, not many, because the unique index on client_mutation_id
// causes the second insert to be skipped.

const doorOutcome = z.enum(["address_not_found"]);
const buildingOutcome = z.enum(["inaccessible"]);
const personOutcome = z.enum(["not_home", "deceased", "hostile", "moved"]);

export const submitDoorResult = mut
  .input(
    z.object({
      clientMutationId: z.string(),
      turfId: z.string().uuid(),
      doorId: z.string().uuid(),
      outcome: doorOutcome,
    }),
  )
  .handler(async ({ context, input }) => {
    await context.db
      .insert(canvassResultsDoors)
      .values({
        clientMutationId: input.clientMutationId,
        doorId: input.doorId,
        turfId: input.turfId,
        outcome: input.outcome,
        createdBy: context.user.userId,
      })
      .onConflictDoNothing({ target: canvassResultsDoors.clientMutationId });
    return { ok: true };
  });

export const submitBuildingResult = mut
  .input(
    z.object({
      clientMutationId: z.string(),
      turfId: z.string().uuid(),
      buildingId: z.string().uuid(),
      outcome: buildingOutcome,
    }),
  )
  .handler(async ({ context, input }) => {
    await context.db
      .insert(canvassResultsBuildings)
      .values({
        clientMutationId: input.clientMutationId,
        buildingId: input.buildingId,
        turfId: input.turfId,
        outcome: input.outcome,
        createdBy: context.user.userId,
      })
      .onConflictDoNothing({ target: canvassResultsBuildings.clientMutationId });
    return { ok: true };
  });

// Submit a single per-person result. Each call writes one row in
// canvass_results_persons. The native app calls this once per non-empty draft
// field on commit (so a single Person-screen visit can produce up to three
// calls: one survey, one outcome, one note), each with its own clientMutationId.
export const submitPersonResult = mut
  .input(
    z.object({
      clientMutationId: z.string(),
      turfId: z.string().uuid(),
      buildingId: z.string().uuid(),
      doorId: z.string().uuid(),
      personId: z.string(),
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
          kind: z.literal("note"),
          text: z.string().min(1),
        }),
        z.object({
          kind: z.literal("empty"),
        }),
      ]),
    }),
  )
  .handler(async ({ context, input }) => {
    const base = {
      clientMutationId: input.clientMutationId,
      userId: context.user.userId,
      voterId: input.personId,
      buildingId: input.buildingId,
      doorId: input.doorId,
      turfId: input.turfId,
      canvassedAt: new Date(),
    };

    let row;
    switch (input.payload.kind) {
      case "survey":
        row = {
          ...base,
          surveyQuestionId: input.payload.surveyQuestionId,
          surveyResponseOptionId: input.payload.surveyResponseOptionId,
        };
        break;
      case "outcome":
        row = { ...base, outcome: input.payload.outcome };
        break;
      case "note":
        row = { ...base, notes: input.payload.text };
        break;
      case "empty":
        row = { ...base, empty: true };
        break;
    }

    await context.db
      .insert(canvassResultsPersons)
      .values(row)
      .onConflictDoNothing({ target: canvassResultsPersons.clientMutationId });
    return { ok: true };
  });

// Hydrate a device's local cache with all canvass results for a turf. Used
// when the native app first loads a turf so prior results show up immediately.
export const listForTurf = pub
  .input(z.object({ turfId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const doors = await context.db
      .select()
      .from(canvassResultsDoors)
      .where(eq(canvassResultsDoors.turfId, input.turfId))
      .orderBy(canvassResultsDoors.createdAt);

    const buildings = await context.db
      .select()
      .from(canvassResultsBuildings)
      .where(eq(canvassResultsBuildings.turfId, input.turfId))
      .orderBy(canvassResultsBuildings.createdAt);

    const persons = await context.db
      .select()
      .from(canvassResultsPersons)
      .where(eq(canvassResultsPersons.turfId, input.turfId))
      .orderBy(canvassResultsPersons.canvassedAt);

    return { doors, buildings, persons };
  });
