import { asc, eq } from "@field-tools/db";
import {
  scriptQuestions,
  scripts,
  surveyQuestions,
  surveyResponseOptions,
} from "@field-tools/db/schema";
import { z } from "zod";
import { pub } from "./context";

// Fetch a script with its questions and response options, ordered for display.
export const get = pub
  .input(z.object({ scriptId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const scriptRows = await context.db
      .select()
      .from(scripts)
      .where(eq(scripts.scriptId, input.scriptId));
    const script = scriptRows[0];
    if (!script) return null;

    const questionRows = await context.db
      .select({
        surveyQuestionId: surveyQuestions.surveyQuestionId,
        text: surveyQuestions.text,
        order: scriptQuestions.order,
      })
      .from(scriptQuestions)
      .innerJoin(
        surveyQuestions,
        eq(scriptQuestions.surveyQuestionId, surveyQuestions.surveyQuestionId),
      )
      .where(eq(scriptQuestions.scriptId, input.scriptId))
      .orderBy(asc(scriptQuestions.order));

    const questionsWithOptions = await Promise.all(
      questionRows.map(async (q) => {
        const options = await context.db
          .select({
            surveyResponseOptionId: surveyResponseOptions.surveyResponseOptionId,
            text: surveyResponseOptions.text,
            order: surveyResponseOptions.order,
          })
          .from(surveyResponseOptions)
          .where(eq(surveyResponseOptions.surveyQuestionId, q.surveyQuestionId))
          .orderBy(asc(surveyResponseOptions.order));
        return { ...q, options };
      }),
    );

    return {
      scriptId: script.scriptId,
      name: script.name,
      questions: questionsWithOptions,
    };
  });
