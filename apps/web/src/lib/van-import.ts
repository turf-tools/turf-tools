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

export type VanSurveyAnswer = {
  vanId: string;
  questionVanId: string;
  responseVanId: string;
  questionName: string;
  responseName: string;
  /** Parsed DateCanvassed (noon UTC on that calendar day). */
  canvassedAt: Date;
};

export type VanSurveyQuestionPreview = {
  questionVanId: string;
  name: string;
  answerCount: number;
  /** Response options in first-seen order. */
  responses: { responseVanId: string; text: string; count: number }[];
  /** True when any person has >1 distinct response on the same day. */
  multiSelect: boolean;
};

export type VanSurveyParse = {
  ok: boolean;
  missingColumns: string[];
  rowCount: number;
  answers: VanSurveyAnswer[];
  questions: VanSurveyQuestionPreview[];
};

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

export function parseVanSurveyExport(text: string): VanSurveyParse {
  const { columns, rows: raw } = tsvTable(text);
  const missingColumns = VAN_SURVEY_REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missingColumns.length > 0) {
    return {
      ok: false,
      missingColumns: [...missingColumns],
      rowCount: 0,
      answers: [],
      questions: [],
    };
  }

  const vanIdx = columns.indexOf(VAN_ID_COLUMN);
  const qIdIdx = columns.indexOf("SurveyQuestionId");
  const rIdIdx = columns.indexOf("SurveyResponseId");
  const qNameIdx = columns.indexOf("SurveyQuestionLongName");
  const rNameIdx = columns.indexOf("SurveyResponseName");
  const dateIdx = columns.indexOf("DateCanvassed");

  const answers: VanSurveyAnswer[] = [];
  // questionVanId → responseVanId → { text, count, order }
  const qMeta = new Map<
    string,
    {
      name: string;
      responses: Map<string, { text: string; count: number; order: number }>;
      // person+day keys that saw >1 response
      multiDays: Set<string>;
      dayResponses: Map<string, Set<string>>;
    }
  >();

  for (const cells of raw) {
    const vanId = (cells[vanIdx] ?? "").trim();
    const questionVanId = (cells[qIdIdx] ?? "").trim();
    const responseVanId = (cells[rIdIdx] ?? "").trim();
    const questionName = (cells[qNameIdx] ?? "").trim();
    const responseName = (cells[rNameIdx] ?? "").trim();
    const dateRaw = (cells[dateIdx] ?? "").trim();
    if (!vanId || !questionVanId || !responseVanId || !responseName) continue;
    const canvassedAt = parseVanDate(dateRaw);
    if (!canvassedAt) continue;

    answers.push({
      vanId,
      questionVanId,
      responseVanId,
      questionName: questionName || questionVanId,
      responseName,
      canvassedAt,
    });

    let meta = qMeta.get(questionVanId);
    if (!meta) {
      meta = {
        name: questionName || questionVanId,
        responses: new Map(),
        multiDays: new Set(),
        dayResponses: new Map(),
      };
      qMeta.set(questionVanId, meta);
    }
    if (questionName) meta.name = questionName;
    const existing = meta.responses.get(responseVanId);
    if (existing) {
      existing.count += 1;
      if (responseName) existing.text = responseName;
    } else {
      meta.responses.set(responseVanId, {
        text: responseName,
        count: 1,
        order: meta.responses.size,
      });
    }
    const dayKey = `${vanId}|${canvassedAt.toISOString().slice(0, 10)}`;
    let daySet = meta.dayResponses.get(dayKey);
    if (!daySet) {
      daySet = new Set();
      meta.dayResponses.set(dayKey, daySet);
    }
    daySet.add(responseVanId);
    if (daySet.size > 1) meta.multiDays.add(dayKey);
  }

  const questions: VanSurveyQuestionPreview[] = [...qMeta.entries()]
    .map(([questionVanId, meta]) => ({
      questionVanId,
      name: meta.name,
      answerCount: [...meta.responses.values()].reduce((n, r) => n + r.count, 0),
      responses: [...meta.responses.entries()]
        .sort((a, b) => a[1].order - b[1].order)
        .map(([responseVanId, r]) => ({
          responseVanId,
          text: r.text,
          count: r.count,
        })),
      multiSelect: meta.multiDays.size > 0,
    }))
    .sort((a, b) => b.answerCount - a.answerCount);

  return {
    ok: true,
    missingColumns: [],
    rowCount: answers.length,
    answers,
    questions,
  };
}

export function parseVanSurveyExportBytes(buffer: ArrayBuffer): VanSurveyParse {
  return parseVanSurveyExport(decodeVanExportBytes(buffer));
}

export function vanClientEventId(vanId: string, contactedAt: Date): string {
  const day = contactedAt.toISOString().slice(0, 10);
  return `van:${vanId}:${day}`;
}

export type VanImportStats = {
  idMapRows: number;
  surveyRows: number;
  questionsCreated: number;
  questionsUpdated: number;
  questionsMatched: number;
  optionsCreated: number;
  peopleWritten: number;
  peopleSkippedUnmapped: number;
  peopleSkippedUnmatched: number;
  eventsInserted: number;
  eventsDeduped: number;
  sampleUnmappedVanIds: string[];
  sampleUnmatchedExternalIds: string[];
};
