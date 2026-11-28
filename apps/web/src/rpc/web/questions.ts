import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNull, sql, type Db } from "@turf-tools/db";
import {
  questionExternalIds,
  questions,
  responseOptions,
  scriptSteps,
} from "@turf-tools/db/schema";
import { z } from "zod";
import { webMut, webPub } from "../context";

const pub = webPub("scripts.read");
const mut = webMut("scripts.write");

const select = {
  questionId: questions.questionId,
  name: questions.name,
  responseType: questions.responseType,
  text: questions.text,
  createdAt: questions.createdAt,
  archivedAt: questions.archivedAt,
};

// A question is locked while any locked script contains it. Aliased by hand:
// drizzle renders column interpolations unqualified inside a select-field
// fragment, which would make the correlation self-referential.
export const isLocked = sql<boolean>`EXISTS (
  SELECT 1 FROM app.script_steps ss
  INNER JOIN app.scripts s ON s.script_id = ss.script_id
  WHERE ss.question_id = questions.question_id AND s.locked_at IS NOT NULL
)`;

export type ScriptRef = { scriptId: string; name: string; archived: boolean };

// The scripts containing the question, by name.
const scriptRefs = (lockedOnly: boolean) => sql<ScriptRef[]>`COALESCE((
  SELECT json_agg(
    json_build_object('scriptId', s.script_id, 'name', s.name, 'archived', s.archived_at IS NOT NULL)
    ORDER BY s.name
  )
  FROM app.script_steps ss
  INNER JOIN app.scripts s ON s.script_id = ss.script_id
  WHERE ss.question_id = questions.question_id
    ${lockedOnly ? sql`AND s.locked_at IS NOT NULL` : sql``}
), '[]'::json)`;

const usedBy = scriptRefs(false);

// The locked scripts containing the question, so the UI can say what to
// unlock. Empty = editable.
export const lockedBy = scriptRefs(true);

// Active options only, matching what the editor and canvassers see.
const optionCount = sql<number>`(
  SELECT count(*)::int FROM app.response_options o
  WHERE o.question_id = questions.question_id AND o.archived_at IS NULL
)`;

const optionSelect = {
  responseOptionId: responseOptions.responseOptionId,
  text: responseOptions.text,
  order: responseOptions.order,
};

// List questions in the current user's organization.
// `status` filters: "active" (default, archivedAt IS NULL), "archived"
// (archivedAt IS NOT NULL), or "all".
// Each row carries `usedBy`, the scripts containing it (a question appears at
// most once per script).
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
      .select({ ...select, usedBy, lockedBy, optionCount })
      .from(questions)
      .where(
        statusCondition
          ? and(eq(questions.organizationId, context.organizationId), statusCondition)
          : eq(questions.organizationId, context.organizationId),
      )
      .orderBy(asc(questions.createdAt));

    return rows;
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

  const questionIds = qs.map((q) => q.questionId);

  const [opts, extRows] = await Promise.all([
    context.db
      .select({
        questionId: responseOptions.questionId,
        responseOptionId: responseOptions.responseOptionId,
        text: responseOptions.text,
        archivedAt: responseOptions.archivedAt,
      })
      .from(responseOptions)
      .where(inArray(responseOptions.questionId, questionIds))
      .orderBy(asc(responseOptions.order)),
    context.db
      .select({
        questionId: questionExternalIds.questionId,
        sourceType: questionExternalIds.sourceType,
        externalId: questionExternalIds.externalId,
      })
      .from(questionExternalIds)
      .where(inArray(questionExternalIds.questionId, questionIds)),
  ]);

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
  const extByQuestion = new Map<string, { sourceType: string; externalId: string }[]>();
  for (const e of extRows) {
    const list = extByQuestion.get(e.questionId) ?? [];
    list.push({ sourceType: e.sourceType, externalId: e.externalId });
    extByQuestion.set(e.questionId, list);
  }
  return qs.map((q) => ({
    questionId: q.questionId,
    name: q.name,
    responseType: q.responseType,
    archived: q.archivedAt !== null,
    externalIds: extByQuestion.get(q.questionId) ?? [],
    options: byQuestion.get(q.questionId) ?? [],
  }));
});

export const getById = pub
  .input(z.object({ questionId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select({ ...select, lockedBy })
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
// (staleTime 0) so the block decision never acts on a stale cache.
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

    const [used, gating] = await Promise.all([
      context.db
        .select({ count: sql<number>`count(*)::int` })
        .from(scriptSteps)
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
      gatingOptionIds: gating.map((g) => g.responseOptionId),
    };
  });

export const create = mut
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

async function assertEditable(db: Db, organizationId: string, questionId: string) {
  const rows = await db
    .select({ isLocked })
    .from(questions)
    .where(and(eq(questions.questionId, questionId), eq(questions.organizationId, organizationId)));
  if (rows.length === 0) throw new ORPCError("NOT_FOUND", { message: "Question not found" });
  if (rows[0]!.isLocked)
    throw new ORPCError("CONFLICT", {
      message: "This question is in a locked script. Unlock the script to edit.",
    });
}

// Copies the question's type, text, and active options into a new question
// outside any script, so it starts unlocked — the way to edit a question a
// locked script is using without touching that script's answers.
export const clone = mut
  .input(z.object({ questionId: z.string().uuid(), name: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select()
      .from(questions)
      .where(
        and(
          eq(questions.questionId, input.questionId),
          eq(questions.organizationId, context.organizationId),
        ),
      );
    const source = rows[0];
    if (!source) throw new ORPCError("NOT_FOUND", { message: "Question not found" });
    const sourceOptions = await context.db
      .select({ text: responseOptions.text })
      .from(responseOptions)
      .where(
        and(eq(responseOptions.questionId, input.questionId), isNull(responseOptions.archivedAt)),
      )
      .orderBy(asc(responseOptions.order));

    return context.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(questions)
        .values({
          organizationId: context.organizationId,
          name: input.name,
          responseType: source.responseType,
          text: source.text,
          createdBy: context.user.id,
        })
        .returning(select);
      const question = inserted[0]!;
      const options =
        sourceOptions.length === 0
          ? []
          : await tx
              .insert(responseOptions)
              .values(
                sourceOptions.map((o, i) => ({
                  questionId: question.questionId,
                  text: o.text,
                  order: i,
                  createdBy: context.user.id,
                })),
              )
              .returning(optionSelect);
      options.sort((a, b) => a.order - b.order);
      return { ...question, lockedBy: [] as ScriptRef[], options };
    });
  });

export const rename = mut
  .input(z.object({ questionId: z.string().uuid(), name: z.string().min(1) }))
  .handler(async ({ context, input }) => {
    await assertEditable(context.db, context.organizationId, input.questionId);
    await context.db
      .update(questions)
      .set({ name: input.name })
      .where(eq(questions.questionId, input.questionId));
    return { ok: true as const };
  });

export const updateText = mut
  .input(z.object({ questionId: z.string().uuid(), text: z.string() }))
  .handler(async ({ context, input }) => {
    await assertEditable(context.db, context.organizationId, input.questionId);
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
export const archive = mut
  .input(z.object({ questionId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    await assertEditable(context.db, context.organizationId, input.questionId);

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

export const unarchive = mut
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

export const addResponseOption = mut
  .input(z.object({ questionId: z.string().uuid(), text: z.string() }))
  .handler(async ({ context, input }) => {
    await assertEditable(context.db, context.organizationId, input.questionId);

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

export const removeResponseOption = mut
  .input(
    z.object({
      questionId: z.string().uuid(),
      responseOptionId: z.string().uuid(),
    }),
  )
  .handler(async ({ context, input }) => {
    await assertEditable(context.db, context.organizationId, input.questionId);

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

export const reorderResponseOptions = mut
  .input(
    z.object({
      questionId: z.string().uuid(),
      responseOptionIds: z.array(z.string().uuid()),
    }),
  )
  .handler(async ({ context, input }) => {
    await assertEditable(context.db, context.organizationId, input.questionId);

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

export const updateResponseOptionText = mut
  .input(
    z.object({
      questionId: z.string().uuid(),
      responseOptionId: z.string().uuid(),
      text: z.string(),
    }),
  )
  .handler(async ({ context, input }) => {
    await assertEditable(context.db, context.organizationId, input.questionId);
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
