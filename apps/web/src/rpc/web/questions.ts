import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNull, sql } from "@field-tools/db";
import { scriptSteps, questions, responseOptions } from "@field-tools/db/schema";
import { z } from "zod";
import { webPub as pub } from "../context";

const select = {
  questionId: questions.questionId,
  name: questions.name,
  responseType: questions.responseType,
  text: questions.text,
  createdAt: questions.createdAt,
  archivedAt: questions.archivedAt,
};

const optionSelect = {
  responseOptionId: responseOptions.responseOptionId,
  text: responseOptions.text,
  order: responseOptions.order,
};

// List questions in the current user's organization.
// `status` filters: "active" (default, archivedAt IS NULL), "archived"
// (archivedAt IS NOT NULL), or "all".
// Each row carries a `usedCount` of how many script_steps reference it.
export const list = pub
  .input(
    z
      .object({
        status: z.enum(["active", "archived", "all"]).optional(),
      })
      .optional(),
  )
  .handler(async ({ context, input }) => {
    const status = input?.status ?? "active";
    const statusCondition =
      status === "active"
        ? isNull(questions.archivedAt)
        : status === "archived"
          ? sql`${questions.archivedAt} IS NOT NULL`
          : undefined;

    const rows = await context.db
      .select(select)
      .from(questions)
      .where(
        statusCondition
          ? and(eq(questions.organizationId, context.organizationId), statusCondition)
          : eq(questions.organizationId, context.organizationId),
      )
      .orderBy(asc(questions.createdAt));

    if (rows.length === 0) return [];

    const counts = await context.db
      .select({
        questionId: scriptSteps.questionId,
        count: sql<number>`count(*)::int`,
      })
      .from(scriptSteps)
      .where(
        inArray(
          scriptSteps.questionId,
          rows.map((r) => r.questionId),
        ),
      )
      .groupBy(scriptSteps.questionId);
    const countMap = new Map(counts.map((c) => [c.questionId, c.count]));

    return rows.map((r) => ({ ...r, usedCount: countMap.get(r.questionId) ?? 0 }));
  });

export const getById = pub
  .input(z.object({ questionId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(select)
      .from(questions)
      .where(
        and(
          eq(questions.questionId, input.questionId),
          eq(questions.organizationId, context.organizationId),
        ),
      );
    const question = rows[0];
    if (!question) return null;

    const options = await context.db
      .select(optionSelect)
      .from(responseOptions)
      .where(eq(responseOptions.questionId, input.questionId))
      .orderBy(asc(responseOptions.order));

    return { ...question, options };
  });

export const create = pub
  .input(
    z.object({
      name: z.string().min(1),
      responseType: z.enum(["single_select"]).optional(),
    }),
  )
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .insert(questions)
      .values({
        organizationId: context.organizationId,
        name: input.name,
        responseType: input.responseType ?? "single_select",
        text: "",
        createdBy: context.user.id,
      })
      .returning(select);
    return rows[0]!;
  });

export const rename = pub
  .input(z.object({ questionId: z.string().uuid(), name: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ questionId: questions.questionId })
      .from(questions)
      .where(
        and(
          eq(questions.questionId, input.questionId),
          eq(questions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });
    await context.db
      .update(questions)
      .set({ name: input.name })
      .where(eq(questions.questionId, input.questionId));
    return { ok: true as const };
  });

export const updateText = pub
  .input(z.object({ questionId: z.string().uuid(), text: z.string() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ questionId: questions.questionId })
      .from(questions)
      .where(
        and(
          eq(questions.questionId, input.questionId),
          eq(questions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });
    await context.db
      .update(questions)
      .set({ text: input.text })
      .where(eq(questions.questionId, input.questionId));
    return { ok: true as const };
  });

// Archive: removes the question from active editors / pickers. Also
// cascades to script_steps — referencing steps are deleted so live
// scripts don't display a stale question. The question row itself
// remains so historical canvass_events keep a valid reference.
export const archive = pub
  .input(z.object({ questionId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ questionId: questions.questionId })
      .from(questions)
      .where(
        and(
          eq(questions.questionId, input.questionId),
          eq(questions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });

    // Snapshot the set of affected script ids before deleting so the
    // client can target invalidations precisely (no broad-prefix nukes).
    const affected = await context.db
      .selectDistinct({ scriptId: scriptSteps.scriptId })
      .from(scriptSteps)
      .where(eq(scriptSteps.questionId, input.questionId));
    const affectedScriptIds = affected.map((r) => r.scriptId);

    await context.db.transaction(async (tx) => {
      await tx.delete(scriptSteps).where(eq(scriptSteps.questionId, input.questionId));
      await tx
        .update(questions)
        .set({ archivedAt: new Date() })
        .where(eq(questions.questionId, input.questionId));
    });
    return { affectedScriptIds };
  });

export const unarchive = pub
  .input(z.object({ questionId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ questionId: questions.questionId })
      .from(questions)
      .where(
        and(
          eq(questions.questionId, input.questionId),
          eq(questions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });
    await context.db
      .update(questions)
      .set({ archivedAt: null })
      .where(eq(questions.questionId, input.questionId));
    return { ok: true as const };
  });

// --- Response option mutations ---

export const addResponseOption = pub
  .input(z.object({ questionId: z.string().uuid(), text: z.string() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ questionId: questions.questionId })
      .from(questions)
      .where(
        and(
          eq(questions.questionId, input.questionId),
          eq(questions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });

    const existing = await context.db
      .select({ order: responseOptions.order })
      .from(responseOptions)
      .where(eq(responseOptions.questionId, input.questionId));
    const nextOrder = existing.length === 0 ? 0 : Math.max(...existing.map((r) => r.order)) + 1;

    const rows = await context.db
      .insert(responseOptions)
      .values({
        questionId: input.questionId,
        text: input.text,
        order: nextOrder,
        createdBy: context.user.id,
      })
      .returning(optionSelect);
    return rows[0]!;
  });

export const removeResponseOption = pub
  .input(
    z.object({
      questionId: z.string().uuid(),
      responseOptionId: z.string().uuid(),
    }),
  )
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ questionId: questions.questionId })
      .from(questions)
      .where(
        and(
          eq(questions.questionId, input.questionId),
          eq(questions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });
    await context.db
      .delete(responseOptions)
      .where(
        and(
          eq(responseOptions.responseOptionId, input.responseOptionId),
          eq(responseOptions.questionId, input.questionId),
        ),
      );
    return { ok: true as const };
  });

export const reorderResponseOptions = pub
  .input(
    z.object({
      questionId: z.string().uuid(),
      responseOptionIds: z.array(z.string().uuid()),
    }),
  )
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ questionId: questions.questionId })
      .from(questions)
      .where(
        and(
          eq(questions.questionId, input.questionId),
          eq(questions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });

    const existing = await context.db
      .select({ responseOptionId: responseOptions.responseOptionId })
      .from(responseOptions)
      .where(eq(responseOptions.questionId, input.questionId));
    const existingIds = new Set(existing.map((r) => r.responseOptionId));
    for (const id of input.responseOptionIds) {
      if (!existingIds.has(id))
        throw new ORPCError("BAD_REQUEST", { message: `Option ${id} not in question` });
    }
    if (input.responseOptionIds.length !== existing.length)
      throw new ORPCError("BAD_REQUEST", { message: "Option list must include every option" });

    await context.db.transaction(async (tx) => {
      for (let i = 0; i < input.responseOptionIds.length; i++) {
        await tx
          .update(responseOptions)
          .set({ order: i })
          .where(eq(responseOptions.responseOptionId, input.responseOptionIds[i]!));
      }
    });
    return { ok: true as const };
  });

export const updateResponseOptionText = pub
  .input(
    z.object({
      questionId: z.string().uuid(),
      responseOptionId: z.string().uuid(),
      text: z.string(),
    }),
  )
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ questionId: questions.questionId })
      .from(questions)
      .where(
        and(
          eq(questions.questionId, input.questionId),
          eq(questions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });
    await context.db
      .update(responseOptions)
      .set({ text: input.text })
      .where(
        and(
          eq(responseOptions.responseOptionId, input.responseOptionId),
          eq(responseOptions.questionId, input.questionId),
        ),
      );
    return { ok: true as const };
  });
