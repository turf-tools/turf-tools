import { asc, eq, inArray } from "@field-tools/db";
import {
  scripts,
  scriptSteps,
  surveyQuestions,
  surveyResponseOptions,
} from "@field-tools/db/schema";
import { z } from "zod";
import { nativePub as pub } from "../context";

// Fetch a script with its full step sequence — questions interleaved with
// text blocks, ordered as the canvasser should read them at the door.
// The scriptId comes from the turf payload; capability-based auth.
//
// Wire shape:
//   { scriptId, name, steps: [
//       { stepType: "text", text, order } |
//       { stepType: "question", surveyQuestionId, responseType, text, order, options: [...] }
//   ] }
export const get = pub
  .input(z.object({ scriptId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const scriptRows = await context.db
      .select()
      .from(scripts)
      .where(eq(scripts.scriptId, input.scriptId));
    const script = scriptRows[0];
    if (!script) return null;

    const stepRows = await context.db
      .select({
        scriptStepId: scriptSteps.scriptStepId,
        stepType: scriptSteps.stepType,
        order: scriptSteps.order,
        surveyQuestionId: scriptSteps.surveyQuestionId,
        stepText: scriptSteps.text,
      })
      .from(scriptSteps)
      .where(eq(scriptSteps.scriptId, input.scriptId))
      .orderBy(asc(scriptSteps.order));

    // Batch-fetch all referenced questions + their options.
    const questionIds = stepRows
      .filter(
        (s): s is typeof s & { surveyQuestionId: string } =>
          s.stepType === "question" && s.surveyQuestionId !== null,
      )
      .map((s) => s.surveyQuestionId);

    const questionRows =
      questionIds.length === 0
        ? []
        : await context.db
            .select({
              surveyQuestionId: surveyQuestions.surveyQuestionId,
              responseType: surveyQuestions.responseType,
              text: surveyQuestions.text,
            })
            .from(surveyQuestions)
            .where(inArray(surveyQuestions.surveyQuestionId, questionIds));
    const questionById = new Map(questionRows.map((q) => [q.surveyQuestionId, q]));

    const optionRows =
      questionIds.length === 0
        ? []
        : await context.db
            .select({
              surveyResponseOptionId: surveyResponseOptions.surveyResponseOptionId,
              surveyQuestionId: surveyResponseOptions.surveyQuestionId,
              text: surveyResponseOptions.text,
              order: surveyResponseOptions.order,
            })
            .from(surveyResponseOptions)
            .where(inArray(surveyResponseOptions.surveyQuestionId, questionIds))
            .orderBy(asc(surveyResponseOptions.order));
    const optionsByQuestion = new Map<string, typeof optionRows>();
    for (const opt of optionRows) {
      const list = optionsByQuestion.get(opt.surveyQuestionId) ?? [];
      list.push(opt);
      optionsByQuestion.set(opt.surveyQuestionId, list);
    }

    type NativeScriptStep =
      | { scriptStepId: string; stepType: "text"; order: number; text: string }
      | {
          scriptStepId: string;
          stepType: "question";
          order: number;
          surveyQuestionId: string;
          responseType: string;
          text: string;
          options: Array<{ surveyResponseOptionId: string; text: string; order: number }>;
        };

    const steps: NativeScriptStep[] = [];
    for (const s of stepRows) {
      if (s.stepType === "text") {
        steps.push({
          scriptStepId: s.scriptStepId,
          stepType: "text",
          order: s.order,
          text: s.stepText ?? "",
        });
      } else if (s.stepType === "question" && s.surveyQuestionId) {
        const q = questionById.get(s.surveyQuestionId);
        if (!q) continue;
        steps.push({
          scriptStepId: s.scriptStepId,
          stepType: "question",
          order: s.order,
          surveyQuestionId: q.surveyQuestionId,
          responseType: q.responseType,
          text: q.text,
          options: (optionsByQuestion.get(q.surveyQuestionId) ?? []).map((o) => ({
            surveyResponseOptionId: o.surveyResponseOptionId,
            text: o.text,
            order: o.order,
          })),
        });
      }
    }

    return {
      scriptId: script.scriptId,
      name: script.name,
      steps,
    };
  });
