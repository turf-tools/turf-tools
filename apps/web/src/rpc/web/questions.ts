import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNull, sql } from "@turf-tools/db";
import { scriptSteps, questions, responseOptions, turfs } from "@turf-tools/db/schema";
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

// Questions (active + archived, flagged) with their response options inlined —
// one round-trip so the canvass-response filter editor gets names + options
// without a per-question follow-up. It offers active by default and reveals
// archived on demand (so filters on since-archived questions/options resolve).
export const listWithOptions = pub.handler(async ({ context }) => {
  const qs = await context.db
    .select({
      questionId: questions.questionId,
      name: questions.name,
      responseType: questions.responseType,
      archivedAt: questions.archivedAt,
    })
    .from(questions)
    .where(eq(questions.organizationId, context.organizationId))
    .orderBy(asc(questions.createdAt));
  if (qs.length === 0) return [];

  const opts = await context.db
    .select({
      questionId: responseOptions.questionId,
      responseOptionId: responseOptions.responseOptionId,
      text: responseOptions.text,
      archivedAt: responseOptions.archivedAt,
    })
    .from(responseOptions)
    .where(
      inArray(
        responseOptions.questionId,
        qs.map((q) => q.questionId),
      ),
    )
    .orderBy(asc(responseOptions.order));

  // Include archived options (flagged). The segment editor must still render an
  // archived option an existing filter references, so it stays removable;
  // offering only active options is done client-side.
  const byQuestion = new Map<
    string,
    { responseOptionId: string; text: string; archived: boolean }[]
  >();
  for (const o of opts) {
    const list = byQuestion.get(o.questionId) ?? [];
    list.push({
      responseOptionId: o.responseOptionId,
      text: o.text,
      archived: o.archivedAt !== null,
    });
    byQuestion.set(o.questionId, list);
  }
  return qs.map((q) => ({
    questionId: q.questionId,
    name: q.name,
    responseType: q.responseType,
    archived: q.archivedAt !== null,
    options: byQuestion.get(q.questionId) ?? [],
  }));
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
      .where(
        and(eq(responseOptions.questionId, input.questionId), isNull(responseOptions.archivedAt)),
      )
      .orderBy(asc(responseOptions.order));

    return { ...question, options };
  });

// One-shot freshness probe for the remove/archive gates — fetched on click
// (staleTime 0) so the warn/block decision never acts on a stale cache.
export const liveUsage = pub
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

    const [used, live, gating] = await Promise.all([
      context.db
        .select({ count: sql<number>`count(*)::int` })
        .from(scriptSteps)
        .where(eq(scriptSteps.questionId, input.questionId)),
      // Active turfs whose stamped script includes this question — removals
      // here change what canvassers in those turfs see.
      context.db
        .select({ count: sql<number>`count(distinct ${turfs.turfId})::int` })
        .from(scriptSteps)
        .innerJoin(turfs, and(eq(turfs.scriptId, scriptSteps.scriptId), eq(turfs.status, "active")))
        .where(eq(scriptSteps.questionId, input.questionId)),
      // Options some step's visibility is conditioned on — archiving them
      // (or the whole question) is blocked.
      context.db
        .selectDistinct({ responseOptionId: responseOptions.responseOptionId })
        .from(scriptSteps)
        .innerJoin(
          responseOptions,
          eq(scriptSteps.showIfOptionId, responseOptions.responseOptionId),
        )
        .where(eq(responseOptions.questionId, input.questionId)),
    ]);

    return {
      usedCount: used[0]?.count ?? 0,
      liveTurfCount: live[0]?.count ?? 0,
      gatingOptionIds: gating.map((g) => g.responseOptionId),
    };
  });

export const create = pub
  .input(
    z.object({
      name: z.string().min(1),
      responseType: z.enum(["single_select", "multi_select", "open_ended"]).optional(),
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

    // Blocked while any step's visibility is conditioned on one of this
    // question's options — archiving would delete the controlling step and
    // leave the condition dangling.
    const dependent = await context.db
      .select({ scriptStepId: scriptSteps.scriptStepId })
      .from(scriptSteps)
      .innerJoin(responseOptions, eq(scriptSteps.showIfOptionId, responseOptions.responseOptionId))
      .where(eq(responseOptions.questionId, input.questionId))
      .limit(1);
    if (dependent.length > 0)
      throw new ORPCError("CONFLICT", {
        message:
          "Another script step depends on one of this question's options being selected. Remove that condition from the script first.",
      });

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

    // Blocked while any step's visibility is conditioned on this option — the
    // condition must be removed in the script editor first.
    const dependent = await context.db
      .select({ scriptStepId: scriptSteps.scriptStepId })
      .from(scriptSteps)
      .where(eq(scriptSteps.showIfOptionId, input.responseOptionId))
      .limit(1);
    if (dependent.length > 0)
      throw new ORPCError("CONFLICT", {
        message:
          "Another script step depends on this option being selected. Remove that condition from the script first.",
      });

    // Soft-delete: canvass responses + segment filters reference this option id
    // and must stay resolvable.
    await context.db
      .update(responseOptions)
      .set({ archivedAt: new Date() })
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
      .where(
        and(eq(responseOptions.questionId, input.questionId), isNull(responseOptions.archivedAt)),
      );
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
