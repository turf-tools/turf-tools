import type {
  ResponseImportStats,
  SurveyImportAnswer,
  SurveyImportParse,
  SurveyImportRowSkip,
  SurveyQuestionPreview,
} from "./survey-import";

export type {
  ResponseImportStats,
  SurveyImportAnswer,
  SurveyImportParse,
  SurveyImportRowSkip,
  SurveyQuestionPreview,
};

/** @deprecated Use ResponseImportStats. */
export type VanImportStats = ResponseImportStats;

// VAN export parsing for the two-file import:
//   1. Standard Text ID map: StateFileID + Voter File VANID
//   2. Survey results export (long format): one row per answer with
//      SurveyQuestionId / SurveyResponseId / DateCanvassed

export const VAN_STATE_FILE_ID_COLUMN = "StateFileID";
export const VAN_ID_COLUMN = "Voter File VANID";

export const VAN_SURVEY_REQUIRED_COLUMNS = [
  VAN_ID_COLUMN,
  "SurveyQuestionId",
  "SurveyResponseId",
  "SurveyQuestionLongName",
  "SurveyResponseName",
  "DateCanvassed",
] as const;

export function decodeVanExportBytes(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  // UTF-16 LE without BOM: many NULs in the first header row.
  if (bytes.length >= 4 && bytes[1] === 0x00 && bytes[3] === 0x00) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function splitTsvLine(line: string): string[] {
  return line.split("\t").map((cell) => cell.trim());
}

function tsvTable(text: string): { columns: string[]; rows: string[][] } {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { columns: [], rows: [] };
  const columns = splitTsvLine(lines[0]!);
  const rows = lines.slice(1).map(splitTsvLine);
  return { columns, rows };
}

export type VanIdMapRow = { vanId: string; stateFileId: string };

export type VanIdMapParse = {
  ok: boolean;
  missingColumns: string[];
  rowCount: number;
  rows: VanIdMapRow[];
};

export function parseVanIdMap(text: string): VanIdMapParse {
  const { columns, rows: raw } = tsvTable(text);
  const required = [VAN_STATE_FILE_ID_COLUMN, VAN_ID_COLUMN] as const;
  const missingColumns = required.filter((c) => !columns.includes(c));
  if (missingColumns.length > 0) {
    return { ok: false, missingColumns, rowCount: 0, rows: [] };
  }
  const stateIdx = columns.indexOf(VAN_STATE_FILE_ID_COLUMN);
  const vanIdx = columns.indexOf(VAN_ID_COLUMN);
  const rows: VanIdMapRow[] = [];
  for (const cells of raw) {
    const stateFileId = (cells[stateIdx] ?? "").trim();
    const vanId = (cells[vanIdx] ?? "").trim();
    if (!stateFileId || !vanId) continue;
    rows.push({ stateFileId, vanId });
  }
  return { ok: true, missingColumns: [], rowCount: rows.length, rows };
}

export function parseVanIdMapBytes(buffer: ArrayBuffer): VanIdMapParse {
  return parseVanIdMap(decodeVanExportBytes(buffer));
}

/** Source type stamped on question/option external-id refs and imported_responses. */
export const VAN_SOURCE_TYPE = "van";

/** Stable dedupe key for one imported VAN answer option. */
export function vanImportedResponseKey(
  vanId: string,
  contactedAt: Date,
  questionExternalId: string,
  responseExternalId: string,
): string {
  const day = contactedAt.toISOString().slice(0, 10);
  return `${vanId}:${day}:${questionExternalId}:${responseExternalId}`;
}

/** Parse VAN `MM/DD/YYYY` (or `M/D/YYYY`) to noon UTC that day. */
export function parseVanDate(raw: string): Date | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

// Parse a long-format VAN survey-results TSV (decoded text).
//
// Each row is one answer. We emit (1) flat `answers` for the import join and
// (2) per-question previews for the match UI — option lists in first-seen order,
// plus multiSelect when any person has >1 distinct response on the same day.
// Incomplete rows and unparseable DateCanvassed values are counted, sampled,
// and console.warn'd rather than failing the whole parse.
export function parseVanSurveyExport(text: string): SurveyImportParse {
  const { columns, rows: raw } = tsvTable(text);
  const missingColumns = VAN_SURVEY_REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missingColumns.length > 0) {
    return {
      ok: false,
      missingColumns: [...missingColumns],
      rowCount: 0,
      answers: [],
      questions: [],
      rowsSkippedIncomplete: 0,
      rowsSkippedBadDate: 0,
      sampleSkipped: [],
    };
  }

  const vanIdx = columns.indexOf(VAN_ID_COLUMN);
  const qIdIdx = columns.indexOf("SurveyQuestionId");
  const rIdIdx = columns.indexOf("SurveyResponseId");
  const qNameIdx = columns.indexOf("SurveyQuestionLongName");
  const rNameIdx = columns.indexOf("SurveyResponseName");
  const dateIdx = columns.indexOf("DateCanvassed");

  const answers: SurveyImportAnswer[] = [];
  let rowsSkippedIncomplete = 0;
  let rowsSkippedBadDate = 0;
  const sampleSkipped: SurveyImportRowSkip[] = [];
  // Accumulate option catalogs + per person/day response sets while scanning.
  const qMeta = new Map<
    string,
    {
      name: string;
      responses: Map<string, { text: string; count: number; order: number }>;
      multiDays: Set<string>;
      dayResponses: Map<string, Set<string>>;
    }
  >();

  for (let i = 0; i < raw.length; i++) {
    const cells = raw[i]!;
    const line = i + 2; // 1-based; line 1 is the header
    const vanId = (cells[vanIdx] ?? "").trim();
    const questionExternalId = (cells[qIdIdx] ?? "").trim();
    const responseExternalId = (cells[rIdIdx] ?? "").trim();
    const questionName = (cells[qNameIdx] ?? "").trim();
    const responseName = (cells[rNameIdx] ?? "").trim();
    const dateRaw = (cells[dateIdx] ?? "").trim();

    const noteSkip = (reason: SurveyImportRowSkip["reason"]) => {
      if (reason === "incomplete") rowsSkippedIncomplete += 1;
      else rowsSkippedBadDate += 1;
      if (sampleSkipped.length < 20) {
        sampleSkipped.push({
          line,
          reason,
          personVanId: vanId,
          questionExternalId,
          responseExternalId,
          dateRaw,
        });
      }
    };

    if (!vanId || !questionExternalId || !responseExternalId || !responseName) {
      noteSkip("incomplete");
      continue;
    }
    const canvassedAt = parseVanDate(dateRaw);
    if (!canvassedAt) {
      noteSkip("bad_date");
      continue;
    }

    answers.push({
      personVanId: vanId,
      questionExternalId,
      responseExternalId,
      questionName: questionName || questionExternalId,
      responseName,
      canvassedAt,
      sourceKey: vanImportedResponseKey(vanId, canvassedAt, questionExternalId, responseExternalId),
    });

    let meta = qMeta.get(questionExternalId);
    if (!meta) {
      meta = {
        name: questionName || questionExternalId,
        responses: new Map(),
        multiDays: new Set(),
        dayResponses: new Map(),
      };
      qMeta.set(questionExternalId, meta);
    }
    if (questionName) meta.name = questionName;
    const existing = meta.responses.get(responseExternalId);
    if (existing) {
      existing.count += 1;
      if (responseName) existing.text = responseName;
    } else {
      meta.responses.set(responseExternalId, {
        text: responseName,
        count: 1,
        order: meta.responses.size,
      });
    }

    // multi_select if this person answered the question more than once that day.
    const dayKey = `${vanId}|${canvassedAt.toISOString().slice(0, 10)}`;
    let daySet = meta.dayResponses.get(dayKey);
    if (!daySet) {
      daySet = new Set();
      meta.dayResponses.set(dayKey, daySet);
    }
    daySet.add(responseExternalId);
    if (daySet.size > 1) meta.multiDays.add(dayKey);
  }

  // Heaviest questions first — nicer default order in the match dialog.
  const questions: SurveyQuestionPreview[] = [...qMeta.entries()]
    .map(([questionExternalId, meta]) => ({
      questionExternalId,
      name: meta.name,
      answerCount: [...meta.responses.values()].reduce((n, r) => n + r.count, 0),
      responses: [...meta.responses.entries()]
        .sort((a, b) => a[1].order - b[1].order)
        .map(([responseExternalId, r]) => ({
          responseExternalId,
          text: r.text,
          count: r.count,
        })),
      multiSelect: meta.multiDays.size > 0,
    }))
    .sort((a, b) => b.answerCount - a.answerCount);

  const skippedTotal = rowsSkippedIncomplete + rowsSkippedBadDate;
  if (skippedTotal > 0) {
    console.warn(
      `[van-import] skipped ${skippedTotal} survey row(s)` +
        ` (incomplete=${rowsSkippedIncomplete}, bad_date=${rowsSkippedBadDate})`,
      sampleSkipped,
    );
  }

  return {
    ok: true,
    missingColumns: [],
    rowCount: answers.length,
    answers,
    questions,
    rowsSkippedIncomplete,
    rowsSkippedBadDate,
    sampleSkipped,
  };
}

export function parseVanSurveyExportBytes(buffer: ArrayBuffer): SurveyImportParse {
  return parseVanSurveyExport(decodeVanExportBytes(buffer));
}
