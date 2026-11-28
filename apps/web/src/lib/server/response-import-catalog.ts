import { and, eq, ne, type Db } from "@turf-tools/db";
import {
  questionExternalIds,
  questions,
  responseOptionExternalIds,
  responseOptions,
} from "@turf-tools/db/schema";
import type { SurveyQuestionPreview } from "~/lib/survey-import";

// Resolve one survey question external id to an app questions.questionId.
//
// Paths: (1) UI match → stamp external-id ref onto the chosen org question
// (and clear it from any sibling that held it), (2) prior import already
// linked this external id → refresh name/type, (3) else insert a new
// question + ref. External ids are for rematching catalog rows across
// imports, not person identity.
export async function resolveQuestion(
  db: Db,
  opts: {
    organizationId: string;
    userId: string;
    sourceType: string;
    preview: SurveyQuestionPreview;
    matchQuestionId: string | null;
  },
): Promise<{ questionId: string; kind: "created" | "matched" | "updated" }> {
  const responseType = opts.preview.multiSelect ? "multi_select" : "single_select";
  const externalId = opts.preview.questionExternalId;

  // Org-scoped uniqueness: only one question may own this external id for the
  // source. Matching never overwrites name/text (the existing wording wins);
  // multi_select widens responseType when the export needs it, and archived
  // rows revive.
  if (opts.matchQuestionId) {
    await stampQuestionExternalId(db, {
      organizationId: opts.organizationId,
      sourceType: opts.sourceType,
      questionId: opts.matchQuestionId,
      externalId,
    });
    await db
      .update(questions)
      .set({
        ...(opts.preview.multiSelect ? { responseType: "multi_select" as const } : {}),
        archivedAt: null,
      })
      .where(eq(questions.questionId, opts.matchQuestionId));
    return { questionId: opts.matchQuestionId, kind: "matched" };
  }

  // Create path with external id already on file from an earlier import — pull
  // name/text/responseType from this export and unarchive if needed.
  const [byExt] = await db
    .select({ questionId: questionExternalIds.questionId })
    .from(questionExternalIds)
    .where(
      and(
        eq(questionExternalIds.organizationId, opts.organizationId),
        eq(questionExternalIds.sourceType, opts.sourceType),
        eq(questionExternalIds.externalId, externalId),
      ),
    )
    .limit(1);

  if (byExt) {
    await db
      .update(questions)
      .set({
        name: opts.preview.name,
        text: opts.preview.name,
        responseType,
        archivedAt: null,
      })
      .where(eq(questions.questionId, byExt.questionId));
    return { questionId: byExt.questionId, kind: "updated" };
  }

  // Brand-new catalog row; external-id ref lets a later import find it without remapping.
  const [inserted] = await db
    .insert(questions)
    .values({
      organizationId: opts.organizationId,
      name: opts.preview.name,
      text: opts.preview.name,
      responseType,
      createdBy: opts.userId,
    })
    .returning({ questionId: questions.questionId });
  await stampQuestionExternalId(db, {
    organizationId: opts.organizationId,
    sourceType: opts.sourceType,
    questionId: inserted!.questionId,
    externalId,
  });
  return { questionId: inserted!.questionId, kind: "created" };
}

async function stampQuestionExternalId(
  db: Db,
  opts: { organizationId: string; sourceType: string; questionId: string; externalId: string },
): Promise<void> {
  // Free this external id from any other org question for this source.
  await db
    .delete(questionExternalIds)
    .where(
      and(
        eq(questionExternalIds.organizationId, opts.organizationId),
        eq(questionExternalIds.sourceType, opts.sourceType),
        eq(questionExternalIds.externalId, opts.externalId),
        ne(questionExternalIds.questionId, opts.questionId),
      ),
    );
  // One link per (question, source): replace whatever id was there.
  await db
    .delete(questionExternalIds)
    .where(
      and(
        eq(questionExternalIds.questionId, opts.questionId),
        eq(questionExternalIds.sourceType, opts.sourceType),
        ne(questionExternalIds.externalId, opts.externalId),
      ),
    );
  await db
    .insert(questionExternalIds)
    .values({
      questionId: opts.questionId,
      organizationId: opts.organizationId,
      sourceType: opts.sourceType,
      externalId: opts.externalId,
    })
    .onConflictDoNothing({
      target: [
        questionExternalIds.organizationId,
        questionExternalIds.sourceType,
        questionExternalIds.externalId,
      ],
    });
}

// Link each survey response external id under a question to a response_options row.
//
// Prefer external-id ref, then case-insensitive text (so matching an existing
// question attaches options that already share wording). Missing options are
// inserted; returns questionExt:responseExt → responseOptionId.
export async function linkOptions(
  db: Db,
  opts: {
    userId: string;
    sourceType: string;
    questionId: string;
    preview: SurveyQuestionPreview;
  },
): Promise<{ map: Map<string, string>; created: number }> {
  const out = new Map<string, string>();
  let created = 0;
  const existingOpts = await db
    .select({
      responseOptionId: responseOptions.responseOptionId,
      text: responseOptions.text,
      archivedAt: responseOptions.archivedAt,
    })
    .from(responseOptions)
    .where(eq(responseOptions.questionId, opts.questionId));

  const existingRefs = await db
    .select({
      responseOptionId: responseOptionExternalIds.responseOptionId,
      externalId: responseOptionExternalIds.externalId,
    })
    .from(responseOptionExternalIds)
    .where(
      and(
        eq(responseOptionExternalIds.questionId, opts.questionId),
        eq(responseOptionExternalIds.sourceType, opts.sourceType),
      ),
    );
  const byExt = new Map(existingRefs.map((r) => [r.externalId, r.responseOptionId]));

  // Prefer a live row when duplicate text exists (archived fallback still works).
  const byText = new Map<string, string>();
  for (const o of existingOpts) {
    const key = o.text.trim().toLowerCase();
    if (!byText.has(key) || o.archivedAt == null) byText.set(key, o.responseOptionId);
  }

  let orderCursor = existingOpts.length;
  for (const resp of opts.preview.responses) {
    const mapKey = `${opts.preview.questionExternalId}:${resp.responseExternalId}`;

    // Already linked from a prior import — refresh label and unarchive.
    const byExtId = byExt.get(resp.responseExternalId);
    if (byExtId) {
      await db
        .update(responseOptions)
        .set({ text: resp.text, archivedAt: null })
        .where(eq(responseOptions.responseOptionId, byExtId));
      out.set(mapKey, byExtId);
      continue;
    }

    // First-time match onto an existing option by wording; stamp external id for next time.
    const byTextId = byText.get(resp.text.trim().toLowerCase());
    if (byTextId) {
      await stampOptionExternalId(db, {
        sourceType: opts.sourceType,
        questionId: opts.questionId,
        responseOptionId: byTextId,
        externalId: resp.responseExternalId,
      });
      byExt.set(resp.responseExternalId, byTextId);
      await db
        .update(responseOptions)
        .set({ archivedAt: null })
        .where(eq(responseOptions.responseOptionId, byTextId));
      out.set(mapKey, byTextId);
      continue;
    }

    // Survey option with no counterpart on the question — append it.
    const [inserted] = await db
      .insert(responseOptions)
      .values({
        questionId: opts.questionId,
        text: resp.text,
        order: orderCursor,
        createdBy: opts.userId,
      })
      .returning({ responseOptionId: responseOptions.responseOptionId });
    await stampOptionExternalId(db, {
      sourceType: opts.sourceType,
      questionId: opts.questionId,
      responseOptionId: inserted!.responseOptionId,
      externalId: resp.responseExternalId,
    });
    orderCursor += 1;
    created += 1;
    byExt.set(resp.responseExternalId, inserted!.responseOptionId);
    out.set(mapKey, inserted!.responseOptionId);
  }
  return { map: out, created };
}

async function stampOptionExternalId(
  db: Db,
  opts: { sourceType: string; questionId: string; responseOptionId: string; externalId: string },
): Promise<void> {
  await db
    .delete(responseOptionExternalIds)
    .where(
      and(
        eq(responseOptionExternalIds.questionId, opts.questionId),
        eq(responseOptionExternalIds.sourceType, opts.sourceType),
        eq(responseOptionExternalIds.externalId, opts.externalId),
        ne(responseOptionExternalIds.responseOptionId, opts.responseOptionId),
      ),
    );
  await db
    .delete(responseOptionExternalIds)
    .where(
      and(
        eq(responseOptionExternalIds.responseOptionId, opts.responseOptionId),
        eq(responseOptionExternalIds.sourceType, opts.sourceType),
        ne(responseOptionExternalIds.externalId, opts.externalId),
      ),
    );
  await db
    .insert(responseOptionExternalIds)
    .values({
      responseOptionId: opts.responseOptionId,
      questionId: opts.questionId,
      sourceType: opts.sourceType,
      externalId: opts.externalId,
    })
    .onConflictDoNothing({
      target: [
        responseOptionExternalIds.questionId,
        responseOptionExternalIds.sourceType,
        responseOptionExternalIds.externalId,
      ],
    });
}
