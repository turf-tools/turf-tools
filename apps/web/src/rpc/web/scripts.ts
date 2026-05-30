import { ORPCError } from "@orpc/server";
import { and, asc, eq } from "@field-tools/db";
import { campaigns, scripts, scriptSteps, questions } from "@field-tools/db/schema";
import { z } from "zod";
import { webPub as pub } from "../context";

const scriptSelect = {
  scriptId: scripts.scriptId,
  name: scripts.name,
  createdAt: scripts.createdAt,
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
      await context.db.insert(scriptSteps).values(
        sourceSteps.map((s) => ({
          scriptId: newScript.scriptId,
          order: s.order,
          stepType: s.stepType,
          questionId: s.questionId,
          text: s.text,
        })),
      );
    }

    return newScript;
  });

// Delete a script. Blocks if any campaign still references it.
export const remove = pub
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

    const inUse = await context.db
      .select({ campaignId: campaigns.campaignId })
      .from(campaigns)
      .where(eq(campaigns.scriptId, input.scriptId));
    if (inUse.length > 0) {
      throw new ORPCError("CONFLICT", {
        message:
          `Script is used by ${inUse.length} campaign${inUse.length === 1 ? "" : "s"}. ` +
          "Detach or delete those campaigns first.",
      });
    }

    await context.db.delete(scripts).where(eq(scripts.scriptId, input.scriptId));
    return { ok: true as const };
  });

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
      .where(eq(campaigns.scriptId, input.scriptId));
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
    await context.db
      .delete(scriptSteps)
      .where(
        and(
          eq(scriptSteps.scriptStepId, input.scriptStepId),
          eq(scriptSteps.scriptId, input.scriptId),
        ),
      );
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
