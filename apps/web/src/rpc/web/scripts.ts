import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNull, sql, type Db } from "@turf-tools/db";
import {
  campaigns,
  responseOptions,
  scripts,
  scriptSteps,
  questions,
  turfs,
} from "@turf-tools/db/schema";
import { z } from "zod";
import { webPub as pub } from "../context";

const scriptSelect = {
  scriptId: scripts.scriptId,
  name: scripts.name,
  createdAt: scripts.createdAt,
  isArchived: sql<boolean>`(${scripts.archivedAt} IS NOT NULL)`,
};

// List scripts in the current user's organization, oldest first.
export const list = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  const rows = await context.db
    .select(scriptSelect)
    .from(scripts)
    .where(eq(scripts.organizationId, context.organizationId))
    .orderBy(asc(scripts.createdAt));
  return rows;
});

// Fetch one script by id with its steps in order. Org-scoped.
export const getById = pub
  .input(z.object({ scriptId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(scriptSelect)
      .from(scripts)
      .where(
        and(
          eq(scripts.scriptId, input.scriptId),
          eq(scripts.organizationId, context.organizationId),
        ),
      );
    const script = rows[0];
    if (!script) return null;

    const stepRows = await context.db
      .select({
        scriptStepId: scriptSteps.scriptStepId,
        order: scriptSteps.order,
        stepType: scriptSteps.stepType,
        questionId: scriptSteps.questionId,
        text: scriptSteps.text,
        showIfOptionId: scriptSteps.showIfOptionId,
      })
      .from(scriptSteps)
      .where(eq(scriptSteps.scriptId, input.scriptId))
      .orderBy(asc(scriptSteps.order));

    return { ...script, steps: stepRows };
  });

// Create an empty script. Steps are added via the editor.
export const create = pub
  .input(z.object({ name: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .insert(scripts)
      .values({
        organizationId: context.organizationId,
        name: input.name,
        createdBy: context.user.id,
      })
      .returning(scriptSelect);
    return rows[0]!;
  });

export const rename = pub
  .input(z.object({ scriptId: z.string().uuid(), name: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ scriptId: scripts.scriptId })
      .from(scripts)
      .where(
        and(
          eq(scripts.scriptId, input.scriptId),
          eq(scripts.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Script not found" });
    await context.db
      .update(scripts)
      .set({ name: input.name })
      .where(eq(scripts.scriptId, input.scriptId));
    return { ok: true as const };
  });

// Clone the script row + all step rows under a new scriptId.
export const clone = pub
  .input(z.object({ scriptId: z.string().uuid(), newName: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    const source = await context.db
      .select()
      .from(scripts)
      .where(
        and(
          eq(scripts.scriptId, input.scriptId),
          eq(scripts.organizationId, context.organizationId),
        ),
      );
    if (source.length === 0) throw new ORPCError("NOT_FOUND", { message: "Script not found" });

    const inserted = await context.db
      .insert(scripts)
      .values({
        organizationId: context.organizationId,
        name: input.newName,
        createdBy: context.user.id,
      })
      .returning(scriptSelect);
    const newScript = inserted[0]!;

    const sourceSteps = await context.db
      .select()
      .from(scriptSteps)
      .where(eq(scriptSteps.scriptId, input.scriptId))
      .orderBy(asc(scriptSteps.order));
    if (sourceSteps.length > 0) {
      // Conditions copy verbatim — options are org-level, so they stay valid.
      await context.db.insert(scriptSteps).values(
        sourceSteps.map((s) => ({
          scriptId: newScript.scriptId,
          order: s.order,
          stepType: s.stepType,
          questionId: s.questionId,
          text: s.text,
          showIfOptionId: s.showIfOptionId,
        })),
      );
    }

    return newScript;
  });

// Soft-retire a script: it leaves the rail and pickers but stays
// resolvable for the campaigns and turfs that reference it. Referenced
// scripts live forever; only archived, unreferenced ones can be deleted.
export const archive = pub
  .input(z.object({ scriptId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const updated = await context.db
      .update(scripts)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(scripts.scriptId, input.scriptId),
          eq(scripts.organizationId, context.organizationId),
        ),
      )
      .returning({ scriptId: scripts.scriptId });
    if (updated.length === 0) throw new ORPCError("NOT_FOUND", { message: "Script not found" });
    return { ok: true as const };
  });

export const unarchive = pub
  .input(z.object({ scriptId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const updated = await context.db
      .update(scripts)
      .set({ archivedAt: null })
      .where(
        and(
          eq(scripts.scriptId, input.scriptId),
          eq(scripts.organizationId, context.organizationId),
        ),
      )
      .returning({ scriptId: scripts.scriptId });
    if (updated.length === 0) throw new ORPCError("NOT_FOUND", { message: "Script not found" });
    return { ok: true as const };
  });

// Everything holding a reference to a script, regardless of status —
// permanent deletion must respect archived referencers too, unlike the
// archive warning below. Step rows are the script's own children and
// cascade on delete.
async function removalBlockers(
  db: Db,
  scriptId: string,
): Promise<Array<{ label: string; count: number }>> {
  const [campaignRefs, turfRefs] = await Promise.all([
    db
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .where(eq(campaigns.scriptId, scriptId)),
    db.select({ turfId: turfs.turfId }).from(turfs).where(eq(turfs.scriptId, scriptId)),
  ]);
  return [
    { label: "campaign", count: campaignRefs.length },
    { label: "turf", count: turfRefs.length },
  ].filter((b) => b.count > 0);
}

// What blocks permanent deletion, for the delete dialog. Empty = deletable.
export const removeCheck = pub
  .input(z.object({ scriptId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ scriptId: scripts.scriptId })
      .from(scripts)
      .where(
        and(
          eq(scripts.scriptId, input.scriptId),
          eq(scripts.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Script not found" });
    return { blockers: await removalBlockers(context.db, input.scriptId) };
  });

// Permanently delete an archived, unreferenced script (steps cascade).
// The blocker check re-runs here and the FKs backstop any race.
export const remove = pub
  .input(z.object({ scriptId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select({ archivedAt: scripts.archivedAt })
      .from(scripts)
      .where(
        and(
          eq(scripts.scriptId, input.scriptId),
          eq(scripts.organizationId, context.organizationId),
        ),
      );
    if (rows.length === 0) throw new ORPCError("NOT_FOUND", { message: "Script not found" });
    if (!rows[0]!.archivedAt)
      throw new ORPCError("BAD_REQUEST", { message: "Only archived scripts can be deleted" });
    const blockers = await removalBlockers(context.db, input.scriptId);
    if (blockers.length > 0)
      throw new ORPCError("BAD_REQUEST", {
        message: "This script is still referenced and can't be deleted",
      });
    await context.db.delete(scripts).where(eq(scripts.scriptId, input.scriptId));
    return { ok: true as const };
  });

// Active campaigns only — a reference from an archived campaign is
// expected history, not something the archive warning should count.
export const countCampaigns = pub
  .input(z.object({ scriptId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ scriptId: scripts.scriptId })
      .from(scripts)
      .where(
        and(
          eq(scripts.scriptId, input.scriptId),
          eq(scripts.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Script not found" });

    const refs = await context.db
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .where(and(eq(campaigns.scriptId, input.scriptId), isNull(campaigns.archivedAt)));
    return { count: refs.length };
  });

// --- Step mutations ---

const addStepInput = z.discriminatedUnion("stepType", [
  z.object({
    scriptId: z.string().uuid(),
    stepType: z.literal("question"),
    questionId: z.string().uuid(),
  }),
  z.object({
    scriptId: z.string().uuid(),
    stepType: z.literal("text"),
    text: z.string(),
  }),
]);

// Append a step at the end of the script. Order is computed server-side.
export const addStep = pub.input(addStepInput).handler(async ({ context, input }) => {
  const owned = await context.db
    .select({ scriptId: scripts.scriptId })
    .from(scripts)
    .where(
      and(eq(scripts.scriptId, input.scriptId), eq(scripts.organizationId, context.organizationId)),
    );
  if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Script not found" });

  if (input.stepType === "question") {
    const q = await context.db
      .select({ questionId: questions.questionId })
      .from(questions)
      .where(
        and(
          eq(questions.questionId, input.questionId),
          eq(questions.organizationId, context.organizationId),
        ),
      );
    if (q.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });
  }

  const existing = await context.db
    .select({ order: scriptSteps.order, questionId: scriptSteps.questionId })
    .from(scriptSteps)
    .where(eq(scriptSteps.scriptId, input.scriptId));

  // Canvasser responses key per questionId, so the same question twice
  // in one script would share its answer across both occurrences.
  if (input.stepType === "question") {
    const already = existing.some((s) => s.questionId === input.questionId);
    if (already) {
      throw new ORPCError("CONFLICT", { message: "This question is already in the script" });
    }
  }
  const nextOrder = existing.length === 0 ? 0 : Math.max(...existing.map((r) => r.order)) + 1;

  const rows = await context.db
    .insert(scriptSteps)
    .values({
      scriptId: input.scriptId,
      order: nextOrder,
      stepType: input.stepType,
      questionId: input.stepType === "question" ? input.questionId : null,
      text: input.stepType === "text" ? input.text : null,
    })
    .returning({
      scriptStepId: scriptSteps.scriptStepId,
      order: scriptSteps.order,
      stepType: scriptSteps.stepType,
      questionId: scriptSteps.questionId,
      text: scriptSteps.text,
      showIfOptionId: scriptSteps.showIfOptionId,
    });
  return rows[0]!;
});

export const removeStep = pub
  .input(z.object({ scriptId: z.string().uuid(), scriptStepId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ scriptId: scripts.scriptId })
      .from(scripts)
      .where(
        and(
          eq(scripts.scriptId, input.scriptId),
          eq(scripts.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Script not found" });
    await context.db.transaction(async (tx) => {
      const removed = await tx
        .delete(scriptSteps)
        .where(
          and(
            eq(scriptSteps.scriptStepId, input.scriptStepId),
            eq(scriptSteps.scriptId, input.scriptId),
          ),
        )
        .returning({ questionId: scriptSteps.questionId });
      // Conditions pointing at the removed question's options now have no
      // controller in this script — clear them so those steps show again.
      const questionId = removed[0]?.questionId;
      if (questionId) {
        await tx
          .update(scriptSteps)
          .set({ showIfOptionId: null })
          .where(
            and(
              eq(scriptSteps.scriptId, input.scriptId),
              inArray(
                scriptSteps.showIfOptionId,
                tx
                  .select({ id: responseOptions.responseOptionId })
                  .from(responseOptions)
                  .where(eq(responseOptions.questionId, questionId)),
              ),
            ),
          );
      }
    });
    return { ok: true as const };
  });

// Reassign `order` to match the provided id sequence. The client sends the
// full ordered list; we trust it for the rows it owns (org-scoped via the
// script check) and renumber 0..N-1.
export const reorderSteps = pub
  .input(z.object({ scriptId: z.string().uuid(), scriptStepIds: z.array(z.string().uuid()) }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ scriptId: scripts.scriptId })
      .from(scripts)
      .where(
        and(
          eq(scripts.scriptId, input.scriptId),
          eq(scripts.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Script not found" });

    const existing = await context.db
      .select({ scriptStepId: scriptSteps.scriptStepId })
      .from(scriptSteps)
      .where(eq(scriptSteps.scriptId, input.scriptId));
    const existingIds = new Set(existing.map((r) => r.scriptStepId));
    for (const id of input.scriptStepIds) {
      if (!existingIds.has(id))
        throw new ORPCError("BAD_REQUEST", { message: `Step ${id} not in script` });
    }
    if (input.scriptStepIds.length !== existing.length)
      throw new ORPCError("BAD_REQUEST", { message: "Step list must include every step" });

    await context.db.transaction(async (tx) => {
      for (let i = 0; i < input.scriptStepIds.length; i++) {
        await tx
          .update(scriptSteps)
          .set({ order: i })
          .where(eq(scriptSteps.scriptStepId, input.scriptStepIds[i]!));
      }
      // Conditions may only point backward; a reorder can invert a pair.
      // Clear any condition whose controller no longer precedes its step.
      const steps = await tx
        .select({
          scriptStepId: scriptSteps.scriptStepId,
          order: scriptSteps.order,
          questionId: scriptSteps.questionId,
          showIfOptionId: scriptSteps.showIfOptionId,
        })
        .from(scriptSteps)
        .where(eq(scriptSteps.scriptId, input.scriptId));
      const conditionedOptionIds = steps
        .map((s) => s.showIfOptionId)
        .filter((id): id is string => id != null);
      if (conditionedOptionIds.length > 0) {
        const options = await tx
          .select({
            responseOptionId: responseOptions.responseOptionId,
            questionId: responseOptions.questionId,
          })
          .from(responseOptions)
          .where(inArray(responseOptions.responseOptionId, conditionedOptionIds));
        const questionByOption = new Map(options.map((o) => [o.responseOptionId, o.questionId]));
        const orderByQuestion = new Map(
          steps.filter((s) => s.questionId != null).map((s) => [s.questionId!, s.order]),
        );
        const invalid = steps.filter((s) => {
          if (s.showIfOptionId == null) return false;
          const controllerQuestion = questionByOption.get(s.showIfOptionId);
          const controllerOrder =
            controllerQuestion != null ? orderByQuestion.get(controllerQuestion) : undefined;
          return controllerOrder === undefined || controllerOrder >= s.order;
        });
        if (invalid.length > 0) {
          await tx
            .update(scriptSteps)
            .set({ showIfOptionId: null })
            .where(
              inArray(
                scriptSteps.scriptStepId,
                invalid.map((s) => s.scriptStepId),
              ),
            );
        }
      }
    });
    return { ok: true as const };
  });

export const updateTextStep = pub
  .input(
    z.object({
      scriptId: z.string().uuid(),
      scriptStepId: z.string().uuid(),
      text: z.string(),
    }),
  )
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ scriptId: scripts.scriptId })
      .from(scripts)
      .where(
        and(
          eq(scripts.scriptId, input.scriptId),
          eq(scripts.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Script not found" });
    const rows = await context.db
      .select({ stepType: scriptSteps.stepType })
      .from(scriptSteps)
      .where(
        and(
          eq(scriptSteps.scriptStepId, input.scriptStepId),
          eq(scriptSteps.scriptId, input.scriptId),
        ),
      );
    const step = rows[0];
    if (!step) throw new ORPCError("NOT_FOUND", { message: "Step not found" });
    if (step.stepType !== "text")
      throw new ORPCError("BAD_REQUEST", { message: "Can only edit text on text steps" });
    await context.db
      .update(scriptSteps)
      .set({ text: input.text })
      .where(eq(scriptSteps.scriptStepId, input.scriptStepId));
    return { ok: true as const };
  });

// Set or clear a step's visibility condition. The controlling option must
// belong to an unarchived single-select question that appears as an earlier
// step in the same script — the invariant that keeps visibility a single
// forward pass (see schema comment).
export const setStepCondition = pub
  .input(
    z.object({
      scriptId: z.string().uuid(),
      scriptStepId: z.string().uuid(),
      showIfOptionId: z.string().uuid().nullable(),
    }),
  )
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ scriptId: scripts.scriptId })
      .from(scripts)
      .where(
        and(
          eq(scripts.scriptId, input.scriptId),
          eq(scripts.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Script not found" });

    const steps = await context.db
      .select({
        scriptStepId: scriptSteps.scriptStepId,
        order: scriptSteps.order,
        questionId: scriptSteps.questionId,
      })
      .from(scriptSteps)
      .where(eq(scriptSteps.scriptId, input.scriptId));
    const target = steps.find((s) => s.scriptStepId === input.scriptStepId);
    if (!target) throw new ORPCError("NOT_FOUND", { message: "Step not found" });

    if (input.showIfOptionId !== null) {
      const rows = await context.db
        .select({
          questionId: responseOptions.questionId,
          optionArchivedAt: responseOptions.archivedAt,
          responseType: questions.responseType,
          organizationId: questions.organizationId,
        })
        .from(responseOptions)
        .innerJoin(questions, eq(questions.questionId, responseOptions.questionId))
        .where(eq(responseOptions.responseOptionId, input.showIfOptionId));
      const option = rows[0];
      if (!option || option.organizationId !== context.organizationId)
        throw new ORPCError("NOT_FOUND", { message: "Option not found" });
      if (option.optionArchivedAt != null)
        throw new ORPCError("BAD_REQUEST", { message: "Can't condition on an archived option" });
      if (option.responseType !== "single_select")
        throw new ORPCError("BAD_REQUEST", {
          message: "Conditions can only reference single-select questions",
        });
      const controller = steps.find((s) => s.questionId === option.questionId);
      if (!controller || controller.order >= target.order)
        throw new ORPCError("BAD_REQUEST", {
          message: "The controlling question must be an earlier step in this script",
        });
    }

    await context.db
      .update(scriptSteps)
      .set({ showIfOptionId: input.showIfOptionId })
      .where(eq(scriptSteps.scriptStepId, input.scriptStepId));
    return { ok: true as const };
  });
