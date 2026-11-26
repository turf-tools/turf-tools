import { and, eq, inArray, isNull, ne, type Db } from "@turf-tools/db";
import {
  canvassEvents,
  type CanvassEventPayload,
  questions,
  responseOptions,
} from "@turf-tools/db/schema";
import { dataPostJson } from "~/lib/server/data-proxy";
import { ensureVanHistoryTurf } from "~/lib/server/van-history";
import {
  parseVanIdMapBytes,
  parseVanSurveyExportBytes,
  vanClientEventId,
  type VanImportStats,
  type VanSurveyQuestionPreview,
} from "~/lib/van-import";

/** Per VAN survey question: create a new question, or attach to an existing one. */
export type VanQuestionMapping = {
  questionVanId: string;
  /** Null → create new (or reuse by vanId). Set → match to this org question. */
  questionId: string | null;
};

// Import VAN survey answers into canvass_events.
//
// Inputs: (1) Standard Text ID map (StateFileID ↔ Voter File VANID),
// (2) long-format survey export (one row per answer with SurveyQuestionId /
// SurveyResponseId / DateCanvassed), (3) UI mappings that say create / match /
// skip for each VAN question.
//
// Pipeline: parse → resolve questions & options to app UUIDs → join answers
// onto lake persons via the ID-map file → write one canvass_events result per
// (person, DateCanvassed day) on the org's hidden VAN History turf. Re-imports
// of the same person/day no-op via clientEventId.
export async function runVanResponseImport(
  db: Db,
  opts: {
    organizationId: string;
    orgSlug: string;
    userId: string;
    idMapBuffer: ArrayBuffer;
    surveyBuffer: ArrayBuffer;
    mappings: VanQuestionMapping[];
  },
): Promise<VanImportStats> {
  const idMap = parseVanIdMapBytes(opts.idMapBuffer);
  if (!idMap.ok) {
    throw new Error(
      `ID map missing required column(s): ${idMap.missingColumns.join(", ")}. ` +
        "Need StateFileID and Voter File VANID.",
    );
  }
  const survey = parseVanSurveyExportBytes(opts.surveyBuffer);
  if (!survey.ok) {
    throw new Error(
      `Survey export missing required column(s): ${survey.missingColumns.join(", ")}.`,
    );
  }
  if (opts.mappings.length === 0) {
    throw new Error("Map at least one survey question to import.");
  }

  // Restrict to questions the UI chose to import (skip is simply absent).
  const mappingByVan = new Map(opts.mappings.map((m) => [m.questionVanId, m]));
  const answers = survey.answers.filter((a) => mappingByVan.has(a.questionVanId));
  const questionPreviews = survey.questions.filter((q) => mappingByVan.has(q.questionVanId));
  if (answers.length === 0 || questionPreviews.length === 0) {
    throw new Error("No survey answers to import (check question selection).");
  }

  // Match targets must be live org questions; one existing question can't be
  // claimed by two VAN questions in the same import.
  const matchIds = opts.mappings
    .map((m) => m.questionId)
    .filter((id): id is string => typeof id === "string");
  if (new Set(matchIds).size !== matchIds.length) {
    throw new Error("Each existing question can only be matched to one VAN question.");
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

  // Build VAN SurveyQuestionId / SurveyResponseId → app UUID maps. Matching an
  // existing question stamps vanId on it and links options by vanId or text
  // (creating any options the existing question is missing).
  let questionsCreated = 0;
  let questionsUpdated = 0;
  let questionsMatched = 0;
  let optionsCreated = 0;

  const questionIdByVan = new Map<string, string>();
  const optionIdByVan = new Map<string, string>();

  for (const preview of questionPreviews) {
    const mapping = mappingByVan.get(preview.questionVanId)!;
    const resolved = await resolveQuestion(db, {
      organizationId: opts.organizationId,
      userId: opts.userId,
      preview,
      matchQuestionId: mapping.questionId,
    });
    if (resolved.kind === "created") questionsCreated += 1;
    else if (resolved.kind === "matched") questionsMatched += 1;
    else questionsUpdated += 1;

    questionIdByVan.set(preview.questionVanId, resolved.questionId);

    const linked = await linkOptions(db, {
      userId: opts.userId,
      questionId: resolved.questionId,
      preview,
    });
    optionsCreated += linked.created;
    for (const [key, optionId] of linked.map) optionIdByVan.set(key, optionId);
  }

  // canvass_events require a turfId; the VAN History turf is superseded so it
  // stays off the board while still joining into canvass-response filters.
  const { turfId } = await ensureVanHistoryTurf(db, {
    organizationId: opts.organizationId,
    orgSlug: opts.orgSlug,
    userId: opts.userId,
  });

  // VANID → StateFileID via the map, then keep only people present in the
  // org's active lake version (filters join canvass personId to external_id).
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

  // Collapse long-format rows into one result snapshot per person/day — the
  // same shape the native app writes (outcome + responses keyed by questionId).
  type EventBucket = {
    vanId: string;
    stateFileId: string;
    canvassedAt: Date;
    responses: Map<string, Set<string>>;
  };
  const buckets = new Map<string, EventBucket>();
  for (const { answer: a, stateFileId } of matched) {
    const day = a.canvassedAt.toISOString().slice(0, 10);
    const key = `${a.vanId}|${day}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        vanId: a.vanId,
        stateFileId,
        canvassedAt: a.canvassedAt,
        responses: new Map(),
      };
      buckets.set(key, bucket);
    }
    const questionId = questionIdByVan.get(a.questionVanId);
    const optionId = optionIdByVan.get(`${a.questionVanId}:${a.responseVanId}`);
    if (!questionId || !optionId) continue;
    let optsSet = bucket.responses.get(questionId);
    if (!optsSet) {
      optsSet = new Set();
      bucket.responses.set(questionId, optsSet);
    }
    optsSet.add(optionId);
  }

  const eventRows: {
    clientEventId: string;
    turfId: string;
    personId: string;
    kind: string;
    payload: CanvassEventPayload;
    createdAt: Date;
  }[] = [];

  for (const bucket of buckets.values()) {
    if (bucket.responses.size === 0) continue;
    const responses: Record<string, { optionIds: string[] }> = {};
    for (const [questionId, optionIds] of bucket.responses) {
      responses[questionId] = { optionIds: [...optionIds] };
    }
    eventRows.push({
      clientEventId: vanClientEventId(bucket.vanId, bucket.canvassedAt),
      turfId,
      personId: bucket.stateFileId,
      kind: "result",
      payload: { kind: "result", outcome: "canvassed", responses },
      createdAt: bucket.canvassedAt,
    });
  }

  // Dedup on clientEventId = van:{vanId}:{YYYY-MM-DD}.
  let eventsInserted = 0;
  for (const group of chunk(eventRows, 500)) {
    const result = await db
      .insert(canvassEvents)
      .values(group)
      .onConflictDoNothing({ target: canvassEvents.clientEventId })
      .returning({ sequence: canvassEvents.sequence });
    eventsInserted += result.length;
  }

  return {
    idMapRows: idMap.rowCount,
    surveyRows: survey.rowCount,
    questionsCreated,
    questionsUpdated,
    questionsMatched,
    optionsCreated,
    peopleWritten: new Set(matched.map((r) => r.stateFileId)).size,
    peopleSkippedUnmapped: unmappedVanIds.size,
    peopleSkippedUnmatched: unmatchedExternalIds.length,
    eventsInserted,
    eventsDeduped: eventRows.length - eventsInserted,
    sampleUnmappedVanIds: [...unmappedVanIds].slice(0, 20),
    sampleUnmatchedExternalIds: unmatchedExternalIds.slice(0, 20),
  };
}

async function resolveQuestion(
  db: Db,
  opts: {
    organizationId: string;
    userId: string;
    preview: VanSurveyQuestionPreview;
    matchQuestionId: string | null;
  },
): Promise<{ questionId: string; kind: "created" | "matched" | "updated" }> {
  const responseType = opts.preview.multiSelect ? "multi_select" : "single_select";

  if (opts.matchQuestionId) {
    await db
      .update(questions)
      .set({ vanId: null })
      .where(
        and(
          eq(questions.organizationId, opts.organizationId),
          eq(questions.vanId, opts.preview.questionVanId),
          ne(questions.questionId, opts.matchQuestionId),
        ),
      );
    await db
      .update(questions)
      .set({
        vanId: opts.preview.questionVanId,
        ...(opts.preview.multiSelect ? { responseType: "multi_select" as const } : {}),
        archivedAt: null,
      })
      .where(eq(questions.questionId, opts.matchQuestionId));
    return { questionId: opts.matchQuestionId, kind: "matched" };
  }

  const [byVan] = await db
    .select({ questionId: questions.questionId })
    .from(questions)
    .where(
      and(
        eq(questions.organizationId, opts.organizationId),
        eq(questions.vanId, opts.preview.questionVanId),
      ),
    )
    .limit(1);

  if (byVan) {
    await db
      .update(questions)
      .set({
        name: opts.preview.name,
        text: opts.preview.name,
        responseType,
        archivedAt: null,
      })
      .where(eq(questions.questionId, byVan.questionId));
    return { questionId: byVan.questionId, kind: "updated" };
  }

  const [inserted] = await db
    .insert(questions)
    .values({
      organizationId: opts.organizationId,
      name: opts.preview.name,
      text: opts.preview.name,
      responseType,
      vanId: opts.preview.questionVanId,
      createdBy: opts.userId,
    })
    .returning({ questionId: questions.questionId });
  return { questionId: inserted!.questionId, kind: "created" };
}

async function linkOptions(
  db: Db,
  opts: {
    userId: string;
    questionId: string;
    preview: VanSurveyQuestionPreview;
  },
): Promise<{ map: Map<string, string>; created: number }> {
  const out = new Map<string, string>();
  let created = 0;
  const existingOpts = await db
    .select({
      responseOptionId: responseOptions.responseOptionId,
      vanId: responseOptions.vanId,
      text: responseOptions.text,
      archivedAt: responseOptions.archivedAt,
    })
    .from(responseOptions)
    .where(eq(responseOptions.questionId, opts.questionId));

  const byVan = new Map(
    existingOpts.filter((o) => o.vanId).map((o) => [o.vanId!, o.responseOptionId]),
  );
  const byText = new Map<string, string>();
  for (const o of existingOpts) {
    const key = o.text.trim().toLowerCase();
    if (!byText.has(key) || o.archivedAt == null) byText.set(key, o.responseOptionId);
  }

  let orderCursor = existingOpts.length;
  for (const resp of opts.preview.responses) {
    const mapKey = `${opts.preview.questionVanId}:${resp.responseVanId}`;
    const byVanId = byVan.get(resp.responseVanId);
    if (byVanId) {
      await db
        .update(responseOptions)
        .set({ text: resp.text, archivedAt: null })
        .where(eq(responseOptions.responseOptionId, byVanId));
      out.set(mapKey, byVanId);
      continue;
    }
    const byTextId = byText.get(resp.text.trim().toLowerCase());
    if (byTextId) {
      await db
        .update(responseOptions)
        .set({ vanId: resp.responseVanId, archivedAt: null })
        .where(eq(responseOptions.responseOptionId, byTextId));
      byVan.set(resp.responseVanId, byTextId);
      out.set(mapKey, byTextId);
      continue;
    }
    const [inserted] = await db
      .insert(responseOptions)
      .values({
        questionId: opts.questionId,
        text: resp.text,
        order: orderCursor,
        vanId: resp.responseVanId,
        createdBy: opts.userId,
      })
      .returning({ responseOptionId: responseOptions.responseOptionId });
    orderCursor += 1;
    created += 1;
    out.set(mapKey, inserted!.responseOptionId);
  }
  return { map: out, created };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
