import { and, eq, inArray, isNull, ne, type Db } from "@turf-tools/db";
import {
  importedResponses,
  questionExternalIds,
  questions,
  responseOptionExternalIds,
  responseOptions,
} from "@turf-tools/db/schema";
import { dataPostJson } from "~/lib/server/data-proxy";
import {
  parseS2wPhonebankBytes,
  parseS2wTextbankBytes,
  S2W_PHONEBANK_SOURCE_TYPE,
  S2W_TEXTBANK_SOURCE_TYPE,
} from "~/lib/s2w-import";
import {
  parseVanIdMapBytes,
  parseVanSurveyExportBytes,
  VAN_SOURCE_TYPE,
  type VanImportStats,
  type VanSurveyParse,
  type VanSurveyQuestionPreview,
} from "~/lib/van-import";

/** Per survey question: create a new question, or attach to an existing one. */
export type VanQuestionMapping = {
  questionVanId: string;
  /** Null → create new (or reuse by external id). Set → match to this org question. */
  questionId: string | null;
};

export type SurveyQuestionMapping = VanQuestionMapping;

// Import survey answers into imported_responses (not canvass_events).
//
// Inputs: (1) Standard Text ID map (StateFileID ↔ Voter File VANID) — person
// keys in every current format are VANIDs, (2) a parsed survey (VAN long
// format, S2W phonebank, or S2W textbank), (3) UI mappings create / match /
// skip per question external id.
//
// Pipeline: resolve questions & options to app UUIDs (stamping
// question_external_ids / response_option_external_ids with `sourceType`) →
// join answers onto lake persons via the ID-map file → write one
// imported_responses row per selected option. Re-imports no-op via sourceKey.
export async function runSurveyResponseImport(
  db: Db,
  opts: {
    organizationId: string;
    orgSlug: string;
    userId: string;
    sourceType: string;
    idMapBuffer: ArrayBuffer;
    survey: VanSurveyParse;
    mappings: SurveyQuestionMapping[];
  },
): Promise<VanImportStats> {
  const idMap = parseVanIdMapBytes(opts.idMapBuffer);
  if (!idMap.ok) {
    throw new Error(
      `ID map missing required column(s): ${idMap.missingColumns.join(", ")}. ` +
        "Need StateFileID and Voter File VANID.",
    );
  }
  if (!opts.survey.ok) {
    throw new Error(
      `Survey export missing required column(s): ${opts.survey.missingColumns.join(", ")}.`,
    );
  }
  if (opts.mappings.length === 0) {
    throw new Error("Map at least one survey question to import.");
  }

  // Restrict to questions the UI chose to import (skip is simply absent).
  const mappingByExt = new Map(opts.mappings.map((m) => [m.questionVanId, m]));
  const answers = opts.survey.answers.filter((a) => mappingByExt.has(a.questionVanId));
  const questionPreviews = opts.survey.questions.filter((q) => mappingByExt.has(q.questionVanId));
  if (answers.length === 0 || questionPreviews.length === 0) {
    throw new Error("No survey answers to import (check question selection).");
  }

  // Match targets must be live org questions; one existing question can't be
  // claimed by two survey questions in the same import.
  const matchIds = opts.mappings
    .map((m) => m.questionId)
    .filter((id): id is string => typeof id === "string");
  if (new Set(matchIds).size !== matchIds.length) {
    throw new Error("Each existing question can only be matched to one survey question.");
  }
  if (matchIds.length > 0) {
    const owned = await db
      .select({ questionId: questions.questionId })
      .from(questions)
      .where(
        and(
          eq(questions.organizationId, opts.organizationId),
          inArray(questions.questionId, matchIds),
          isNull(questions.archivedAt),
        ),
      );
    if (owned.length !== matchIds.length) {
      throw new Error("One or more matched questions were not found.");
    }
  }

  // Join this import's answers using the uploaded ID map only — person VANIDs
  // are not persisted.
  const vanToState = new Map<string, string>();
  for (const row of idMap.rows) vanToState.set(row.vanId, row.stateFileId);

  // Build external question/response ids → app UUID maps. Matching an existing
  // question stamps an external-id ref and links options by external id or text
  // (creating any options the existing question is missing).
  let questionsCreated = 0;
  let questionsUpdated = 0;
  let questionsMatched = 0;
  let optionsCreated = 0;

  const questionIdByExt = new Map<string, string>();
  const optionIdByExt = new Map<string, string>();

  for (const preview of questionPreviews) {
    const mapping = mappingByExt.get(preview.questionVanId)!;
    const resolved = await resolveQuestion(db, {
      organizationId: opts.organizationId,
      userId: opts.userId,
      sourceType: opts.sourceType,
      preview,
      matchQuestionId: mapping.questionId,
    });
    if (resolved.kind === "created") questionsCreated += 1;
    else if (resolved.kind === "matched") questionsMatched += 1;
    else questionsUpdated += 1;

    questionIdByExt.set(preview.questionVanId, resolved.questionId);

    const linked = await linkOptions(db, {
      userId: opts.userId,
      sourceType: opts.sourceType,
      questionId: resolved.questionId,
      preview,
    });
    optionsCreated += linked.created;
    for (const [key, optionId] of linked.map) optionIdByExt.set(key, optionId);
  }

  // VANID → StateFileID via the map, then keep only people present in the
  // org's active lake version (filters join personId to external_id).
  const unmappedVanIds = new Set<string>();
  const withState: { answer: (typeof answers)[number]; stateFileId: string }[] = [];
  for (const a of answers) {
    const stateFileId = vanToState.get(a.vanId);
    if (!stateFileId) {
      unmappedVanIds.add(a.vanId);
      continue;
    }
    withState.push({ answer: a, stateFileId });
  }

  const externalIds = [...new Set(withState.map((r) => r.stateFileId))];
  const existing = await dataPostJson<{ externalIds: string[] }>("/persons/existing", {
    orgSlug: opts.orgSlug,
    externalIds,
  });
  const existingSet = new Set(existing.externalIds);

  const matched = withState.filter((r) => existingSet.has(r.stateFileId));
  const unmatchedExternalIds = [
    ...new Set(withState.filter((r) => !existingSet.has(r.stateFileId)).map((r) => r.stateFileId)),
  ];

  // One imported_responses row per selected option (multi-select = many rows).
  const responseRows: {
    organizationId: string;
    personId: string;
    questionId: string;
    responseOptionId: string;
    respondedAt: Date;
    sourceType: string;
    sourceKey: string;
  }[] = [];

  for (const { answer: a, stateFileId } of matched) {
    const questionId = questionIdByExt.get(a.questionVanId);
    const optionId = optionIdByExt.get(`${a.questionVanId}:${a.responseVanId}`);
    if (!questionId || !optionId) continue;
    responseRows.push({
      organizationId: opts.organizationId,
      personId: stateFileId,
      questionId,
      responseOptionId: optionId,
      respondedAt: a.canvassedAt,
      sourceType: opts.sourceType,
      sourceKey: a.sourceKey,
    });
  }

  // Dedup on (org, sourceType, sourceKey).
  let responsesInserted = 0;
  for (const group of chunk(responseRows, 500)) {
    const result = await db
      .insert(importedResponses)
      .values(group)
      .onConflictDoNothing({
        target: [
          importedResponses.organizationId,
          importedResponses.sourceType,
          importedResponses.sourceKey,
        ],
      })
      .returning({ importedResponseId: importedResponses.importedResponseId });
    responsesInserted += result.length;
  }

  return {
    idMapRows: idMap.rowCount,
    surveyRows: opts.survey.rowCount,
    questionsCreated,
    questionsUpdated,
    questionsMatched,
    optionsCreated,
    peopleWritten: new Set(matched.map((r) => r.stateFileId)).size,
    peopleSkippedUnmapped: unmappedVanIds.size,
    peopleSkippedUnmatched: unmatchedExternalIds.length,
    responsesInserted,
    responsesDeduped: responseRows.length - responsesInserted,
    sampleUnmappedVanIds: [...unmappedVanIds].slice(0, 20),
    sampleUnmatchedExternalIds: unmatchedExternalIds.slice(0, 20),
  };
}

export async function runVanResponseImport(
  db: Db,
  opts: {
    organizationId: string;
    orgSlug: string;
    userId: string;
    idMapBuffer: ArrayBuffer;
    surveyBuffer: ArrayBuffer;
    mappings: SurveyQuestionMapping[];
  },
): Promise<VanImportStats> {
  const survey = parseVanSurveyExportBytes(opts.surveyBuffer);
  return runSurveyResponseImport(db, {
    ...opts,
    sourceType: VAN_SOURCE_TYPE,
    survey,
  });
}

export async function runS2wPhonebankImport(
  db: Db,
  opts: {
    organizationId: string;
    orgSlug: string;
    userId: string;
    idMapBuffer: ArrayBuffer;
    surveyBuffer: ArrayBuffer;
    mappings: SurveyQuestionMapping[];
  },
): Promise<VanImportStats> {
  const survey = parseS2wPhonebankBytes(opts.surveyBuffer);
  return runSurveyResponseImport(db, {
    ...opts,
    sourceType: S2W_PHONEBANK_SOURCE_TYPE,
    survey,
  });
}

export async function runS2wTextbankImport(
  db: Db,
  opts: {
    organizationId: string;
    orgSlug: string;
    userId: string;
    idMapBuffer: ArrayBuffer;
    surveyBuffer: ArrayBuffer;
    mappings: SurveyQuestionMapping[];
  },
): Promise<VanImportStats> {
  // Textbank exports have no contact datetime — stamp this import's clock.
  const survey = parseS2wTextbankBytes(opts.surveyBuffer, new Date());
  return runSurveyResponseImport(db, {
    ...opts,
    sourceType: S2W_TEXTBANK_SOURCE_TYPE,
    survey,
  });
}

// Resolve one survey question external id to an app questions.questionId.
//
// Paths: (1) UI match → stamp external-id ref onto the chosen org question
// (and clear it from any sibling that held it), (2) prior import already
// linked this external id → refresh name/type, (3) else insert a new
// question + ref. External ids are for rematching catalog rows across
// imports, not person identity.
async function resolveQuestion(
  db: Db,
  opts: {
    organizationId: string;
    userId: string;
    sourceType: string;
    preview: VanSurveyQuestionPreview;
    matchQuestionId: string | null;
  },
): Promise<{ questionId: string; kind: "created" | "matched" | "updated" }> {
  const responseType = opts.preview.multiSelect ? "multi_select" : "single_select";
  const externalId = opts.preview.questionVanId;

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
async function linkOptions(
  db: Db,
  opts: {
    userId: string;
    sourceType: string;
    questionId: string;
    preview: VanSurveyQuestionPreview;
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
    const mapKey = `${opts.preview.questionVanId}:${resp.responseVanId}`;

    // Already linked from a prior import — refresh label and unarchive.
    const byExtId = byExt.get(resp.responseVanId);
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
        externalId: resp.responseVanId,
      });
      byExt.set(resp.responseVanId, byTextId);
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
      externalId: resp.responseVanId,
    });
    orderCursor += 1;
    created += 1;
    byExt.set(resp.responseVanId, inserted!.responseOptionId);
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
