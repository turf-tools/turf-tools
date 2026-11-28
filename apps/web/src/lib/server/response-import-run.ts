import { and, eq, inArray, isNull, type Db } from "@turf-tools/db";
import { importedResponses, questions } from "@turf-tools/db/schema";
import { dataPostJson } from "~/lib/server/data-proxy";
import { linkOptions, resolveQuestion } from "~/lib/server/response-import-catalog";
import type { ResponseImportStats, SurveyImportParse } from "~/lib/survey-import";
import { parseVanIdMapBytes } from "~/lib/van-import";

/** Per survey question: create a new question, or attach to an existing one. */
export type SurveyQuestionMapping = {
  questionExternalId: string;
  /** Null → create new (or reuse by external id). Set → match to this org question. */
  questionId: string | null;
};

export type ResponseImportBuffers = {
  organizationId: string;
  orgSlug: string;
  userId: string;
  idMapBuffer: ArrayBuffer;
  surveyBuffer: ArrayBuffer;
  mappings: SurveyQuestionMapping[];
};

// Import survey answers into imported_responses (not canvass_events).
//
// Inputs: (1) Standard Text ID map (StateFileID ↔ Voter File VANID) — person
// keys in every current format are VANIDs, (2) a parsed survey, (3) UI
// mappings create / match / skip per question external id.
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
    survey: SurveyImportParse;
    mappings: SurveyQuestionMapping[];
  },
): Promise<ResponseImportStats> {
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
  const mappingByExt = new Map(opts.mappings.map((m) => [m.questionExternalId, m]));
  const answers = opts.survey.answers.filter((a) => mappingByExt.has(a.questionExternalId));
  const questionPreviews = opts.survey.questions.filter((q) =>
    mappingByExt.has(q.questionExternalId),
  );
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
    const mapping = mappingByExt.get(preview.questionExternalId)!;
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

    questionIdByExt.set(preview.questionExternalId, resolved.questionId);

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
    const stateFileId = vanToState.get(a.personVanId);
    if (!stateFileId) {
      unmappedVanIds.add(a.personVanId);
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
    const questionId = questionIdByExt.get(a.questionExternalId);
    const optionId = optionIdByExt.get(`${a.questionExternalId}:${a.responseExternalId}`);
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
