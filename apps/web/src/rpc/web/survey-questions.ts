import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNull, sql } from "@field-tools/db";
import { scriptSteps, surveyQuestions, surveyResponseOptions } from "@field-tools/db/schema";
import { z } from "zod";
import { webPub as pub } from "../context";

const select = {
  surveyQuestionId: surveyQuestions.surveyQuestionId,
  name: surveyQuestions.name,
  responseType: surveyQuestions.responseType,
  text: surveyQuestions.text,
  createdAt: surveyQuestions.createdAt,
  archivedAt: surveyQuestions.archivedAt,
};

const optionSelect = {
  surveyResponseOptionId: surveyResponseOptions.surveyResponseOptionId,
  text: surveyResponseOptions.text,
  order: surveyResponseOptions.order,
};

// List survey questions in the current user's organization.
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
        ? isNull(surveyQuestions.archivedAt)
        : status === "archived"
          ? sql`${surveyQuestions.archivedAt} IS NOT NULL`
          : undefined;

    const rows = await context.db
      .select(select)
      .from(surveyQuestions)
      .where(
        statusCondition
          ? and(eq(surveyQuestions.organizationId, context.organizationId), statusCondition)
          : eq(surveyQuestions.organizationId, context.organizationId),
      )
      .orderBy(asc(surveyQuestions.createdAt));

    if (rows.length === 0) return [];

    const counts = await context.db
      .select({
        surveyQuestionId: scriptSteps.surveyQuestionId,
        count: sql<number>`count(*)::int`,
      })
      .from(scriptSteps)
      .where(
        inArray(
          scriptSteps.surveyQuestionId,
          rows.map((r) => r.surveyQuestionId),
        ),
      )
      .groupBy(scriptSteps.surveyQuestionId);
    const countMap = new Map(counts.map((c) => [c.surveyQuestionId, c.count]));

    return rows.map((r) => ({ ...r, usedCount: countMap.get(r.surveyQuestionId) ?? 0 }));
  });

export const getById = pub
  .input(z.object({ surveyQuestionId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(select)
      .from(surveyQuestions)
      .where(
        and(
          eq(surveyQuestions.surveyQuestionId, input.surveyQuestionId),
          eq(surveyQuestions.organizationId, context.organizationId),
        ),
      );
    const question = rows[0];
    if (!question) return null;

    const options = await context.db
      .select(optionSelect)
      .from(surveyResponseOptions)
      .where(eq(surveyResponseOptions.surveyQuestionId, input.surveyQuestionId))
      .orderBy(asc(surveyResponseOptions.order));

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
      .insert(surveyQuestions)
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
  .input(z.object({ surveyQuestionId: z.string().uuid(), name: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ surveyQuestionId: surveyQuestions.surveyQuestionId })
      .from(surveyQuestions)
      .where(
        and(
          eq(surveyQuestions.surveyQuestionId, input.surveyQuestionId),
          eq(surveyQuestions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });
    await context.db
      .update(surveyQuestions)
      .set({ name: input.name })
      .where(eq(surveyQuestions.surveyQuestionId, input.surveyQuestionId));
    return { ok: true as const };
  });

export const updateText = pub
  .input(z.object({ surveyQuestionId: z.string().uuid(), text: z.string() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ surveyQuestionId: surveyQuestions.surveyQuestionId })
      .from(surveyQuestions)
      .where(
        and(
          eq(surveyQuestions.surveyQuestionId, input.surveyQuestionId),
          eq(surveyQuestions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });
    await context.db
      .update(surveyQuestions)
      .set({ text: input.text })
      .where(eq(surveyQuestions.surveyQuestionId, input.surveyQuestionId));
    return { ok: true as const };
  });

// Archive: removes the question from active editors / pickers. Also
// cascades to script_steps — referencing steps are deleted so live
// scripts don't display a stale question. The question row itself
// remains so historical canvass_events keep a valid reference.
export const archive = pub
  .input(z.object({ surveyQuestionId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ surveyQuestionId: surveyQuestions.surveyQuestionId })
      .from(surveyQuestions)
      .where(
        and(
          eq(surveyQuestions.surveyQuestionId, input.surveyQuestionId),
          eq(surveyQuestions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });

    // Snapshot the set of affected script ids before deleting so the
    // client can target invalidations precisely (no broad-prefix nukes).
    const affected = await context.db
      .selectDistinct({ scriptId: scriptSteps.scriptId })
      .from(scriptSteps)
      .where(eq(scriptSteps.surveyQuestionId, input.surveyQuestionId));
    const affectedScriptIds = affected.map((r) => r.scriptId);

    await context.db.transaction(async (tx) => {
      await tx.delete(scriptSteps).where(eq(scriptSteps.surveyQuestionId, input.surveyQuestionId));
      await tx
        .update(surveyQuestions)
        .set({ archivedAt: new Date() })
        .where(eq(surveyQuestions.surveyQuestionId, input.surveyQuestionId));
    });
    return { affectedScriptIds };
  });

export const unarchive = pub
  .input(z.object({ surveyQuestionId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ surveyQuestionId: surveyQuestions.surveyQuestionId })
      .from(surveyQuestions)
      .where(
        and(
          eq(surveyQuestions.surveyQuestionId, input.surveyQuestionId),
          eq(surveyQuestions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });
    await context.db
      .update(surveyQuestions)
      .set({ archivedAt: null })
      .where(eq(surveyQuestions.surveyQuestionId, input.surveyQuestionId));
    return { ok: true as const };
  });

// --- Response option mutations ---

export const addResponseOption = pub
  .input(z.object({ surveyQuestionId: z.string().uuid(), text: z.string() }))
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ surveyQuestionId: surveyQuestions.surveyQuestionId })
      .from(surveyQuestions)
      .where(
        and(
          eq(surveyQuestions.surveyQuestionId, input.surveyQuestionId),
          eq(surveyQuestions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });

    const existing = await context.db
      .select({ order: surveyResponseOptions.order })
      .from(surveyResponseOptions)
      .where(eq(surveyResponseOptions.surveyQuestionId, input.surveyQuestionId));
    const nextOrder = existing.length === 0 ? 0 : Math.max(...existing.map((r) => r.order)) + 1;

    const rows = await context.db
      .insert(surveyResponseOptions)
      .values({
        surveyQuestionId: input.surveyQuestionId,
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
      surveyQuestionId: z.string().uuid(),
      surveyResponseOptionId: z.string().uuid(),
    }),
  )
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ surveyQuestionId: surveyQuestions.surveyQuestionId })
      .from(surveyQuestions)
      .where(
        and(
          eq(surveyQuestions.surveyQuestionId, input.surveyQuestionId),
          eq(surveyQuestions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });
    await context.db
      .delete(surveyResponseOptions)
      .where(
        and(
          eq(surveyResponseOptions.surveyResponseOptionId, input.surveyResponseOptionId),
          eq(surveyResponseOptions.surveyQuestionId, input.surveyQuestionId),
        ),
      );
    return { ok: true as const };
  });

export const reorderResponseOptions = pub
  .input(
    z.object({
      surveyQuestionId: z.string().uuid(),
      surveyResponseOptionIds: z.array(z.string().uuid()),
    }),
  )
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ surveyQuestionId: surveyQuestions.surveyQuestionId })
      .from(surveyQuestions)
      .where(
        and(
          eq(surveyQuestions.surveyQuestionId, input.surveyQuestionId),
          eq(surveyQuestions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });

    const existing = await context.db
      .select({ surveyResponseOptionId: surveyResponseOptions.surveyResponseOptionId })
      .from(surveyResponseOptions)
      .where(eq(surveyResponseOptions.surveyQuestionId, input.surveyQuestionId));
    const existingIds = new Set(existing.map((r) => r.surveyResponseOptionId));
    for (const id of input.surveyResponseOptionIds) {
      if (!existingIds.has(id))
        throw new ORPCError("BAD_REQUEST", { message: `Option ${id} not in question` });
    }
    if (input.surveyResponseOptionIds.length !== existing.length)
      throw new ORPCError("BAD_REQUEST", { message: "Option list must include every option" });

    await context.db.transaction(async (tx) => {
      for (let i = 0; i < input.surveyResponseOptionIds.length; i++) {
        await tx
          .update(surveyResponseOptions)
          .set({ order: i })
          .where(
            eq(surveyResponseOptions.surveyResponseOptionId, input.surveyResponseOptionIds[i]!),
          );
      }
    });
    return { ok: true as const };
  });

export const updateResponseOptionText = pub
  .input(
    z.object({
      surveyQuestionId: z.string().uuid(),
      surveyResponseOptionId: z.string().uuid(),
      text: z.string(),
    }),
  )
  .handler(async ({ context, input }) => {
    const owned = await context.db
      .select({ surveyQuestionId: surveyQuestions.surveyQuestionId })
      .from(surveyQuestions)
      .where(
        and(
          eq(surveyQuestions.surveyQuestionId, input.surveyQuestionId),
          eq(surveyQuestions.organizationId, context.organizationId),
        ),
      );
    if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });
    await context.db
      .update(surveyResponseOptions)
      .set({ text: input.text })
      .where(
        and(
          eq(surveyResponseOptions.surveyResponseOptionId, input.surveyResponseOptionId),
          eq(surveyResponseOptions.surveyQuestionId, input.surveyQuestionId),
        ),
      );
    return { ok: true as const };
  });
