import { and, asc, eq, inArray, isNull } from "@turf-tools/db";
import { scripts, scriptSteps, questions, responseOptions } from "@turf-tools/db/schema";
import { z } from "zod";
import { nativePub as pub } from "../context";

// Fetch a script with its full step sequence — questions interleaved with
// text blocks, ordered as the canvasser should read them at the door.
// The scriptId comes from the turf payload; capability-based auth.
//
// Wire shape:
//   { scriptId, name, steps: [
//       { stepType: "text", text, order } |
//       { stepType: "question", questionId, responseType, text, order, options: [...] }
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
        questionId: scriptSteps.questionId,
        stepText: scriptSteps.text,
      })
      .from(scriptSteps)
      .where(eq(scriptSteps.scriptId, input.scriptId))
      .orderBy(asc(scriptSteps.order));

    // Batch-fetch all referenced questions + their options.
    const questionIds = stepRows
      .filter(
        (s): s is typeof s & { questionId: string } =>
          s.stepType === "question" && s.questionId !== null,
      )
      .map((s) => s.questionId);

    const questionRows =
      questionIds.length === 0
        ? []
        : await context.db
            .select({
              questionId: questions.questionId,
              responseType: questions.responseType,
              text: questions.text,
            })
            .from(questions)
            .where(inArray(questions.questionId, questionIds));
    const questionById = new Map(questionRows.map((q) => [q.questionId, q]));

    const optionRows =
      questionIds.length === 0
        ? []
        : await context.db
            .select({
              responseOptionId: responseOptions.responseOptionId,
              questionId: responseOptions.questionId,
              text: responseOptions.text,
              order: responseOptions.order,
            })
            .from(responseOptions)
            .where(
              and(
                inArray(responseOptions.questionId, questionIds),
                isNull(responseOptions.archivedAt),
              ),
            )
            .orderBy(asc(responseOptions.order));
    const optionsByQuestion = new Map<string, typeof optionRows>();
    for (const opt of optionRows) {
      const list = optionsByQuestion.get(opt.questionId) ?? [];
      list.push(opt);
      optionsByQuestion.set(opt.questionId, list);
    }

    type NativeScriptStep =
      | { scriptStepId: string; stepType: "text"; order: number; text: string }
      | {
          scriptStepId: string;
          stepType: "question";
          order: number;
          questionId: string;
          responseType: string;
          text: string;
          options: Array<{ responseOptionId: string; text: string; order: number }>;
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
      } else if (s.stepType === "question" && s.questionId) {
        const q = questionById.get(s.questionId);
        if (!q) continue;
        steps.push({
          scriptStepId: s.scriptStepId,
          stepType: "question",
          order: s.order,
          questionId: q.questionId,
          responseType: q.responseType,
          text: q.text,
          options: (optionsByQuestion.get(q.questionId) ?? []).map((o) => ({
            responseOptionId: o.responseOptionId,
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
