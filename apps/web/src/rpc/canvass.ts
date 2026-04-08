import { canvassResultsDoors, canvassResultsPeople } from "@field-tools/db/schema";
import { z } from "zod";
import { mut } from "./context";

// Submit a canvass outcome for a single door. Optionally includes per-person
// survey responses. door_id / person_id are the global UUIDs from the turf
// data blob (which are the same UUIDs assigned by the DuckLake import pipeline).
export const submitDoorResult = mut
  .input(
    z.object({
      turfId: z.string().uuid(),
      doorId: z.string().uuid(),
      outcome: z.enum(["hit", "not_home", "refused", "bad_address", "moved"]),
      peopleResponses: z
        .array(
          z.object({
            personId: z.string(),
            surveyQuestionId: z.string().uuid(),
            surveyResponseOptionId: z.string().uuid().optional(),
            notes: z.string().optional(),
          }),
        )
        .optional(),
    }),
  )
  .handler(async ({ context, input }) => {
    const now = new Date();

    await context.db.insert(canvassResultsDoors).values({
      doorId: input.doorId,
      turfId: input.turfId,
      outcome: input.outcome,
      createdBy: context.user.userId,
    });

    if (input.peopleResponses && input.peopleResponses.length > 0) {
      await context.db.insert(canvassResultsPeople).values(
        input.peopleResponses.map((r) => ({
          userId: context.user.userId,
          voterId: r.personId,
          doorId: input.doorId,
          turfId: input.turfId,
          outcome: input.outcome,
          surveyQuestionId: r.surveyQuestionId,
          surveyResponseOptionId: r.surveyResponseOptionId,
          notes: r.notes,
          canvassedAt: now,
        })),
      );
    }

    return { ok: true };
  });
