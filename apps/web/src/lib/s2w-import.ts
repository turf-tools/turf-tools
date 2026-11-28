import type { SurveyImportAnswer, SurveyImportParse, SurveyQuestionPreview } from "./survey-import";

/** `imported_responses.source_type` / external-id refs for phonebank exports. */
export const S2W_PHONEBANK_SOURCE_TYPE = "s2w_phonebank";
/** `imported_responses.source_type` / external-id refs for textbank exports. */
export const S2W_TEXTBANK_SOURCE_TYPE = "s2w_textbank";

const PHONE_PERSON_COL = "Contact VanID";
const PHONE_DATE_COL = "Call Date/Time";
const PHONE_CALL_ID_COL = "Call ID";
/** First survey column in ScaleToWin phonebank exports. */
const PHONE_FIRST_ANSWER_COL = "Canvass Result";
/** Trailing free-text note column — not a coded response. */
const PHONE_SKIP_COLS = new Set(["End"]);

const TEXT_PERSON_COL = "van_id";
const TAG_PREFIX = "Tag: ";
/** Disposition-style tag options that are not survey answers (even as `Q > …`). */
const TEXT_SKIP_OPTIONS = new Set(["wrong number", "hostile"]);

const OPTION_COL_RE = /^(.+) \[([^\]]+)\]$/;

/**
 * CSV table parse that keeps newlines inside quoted fields (ScaleToWin
 * textbank `Contact Script` cells often span multiple lines).
 */
function splitCsv(text: string): { columns: string[]; rows: string[][] } {
  const src = text.replace(/^\uFEFF/, "");
  if (src.length === 0) return { columns: [], rows: [] };

  const table: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;

  const pushCell = () => {
    row.push(cur);
    cur = "";
  };
  const pushRow = () => {
    // Skip blank trailing lines (a lone empty row).
    if (row.length === 1 && row[0] === "" && table.length > 0) {
      row = [];
      return;
    }
    table.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushCell();
    } else if (ch === "\n") {
      pushCell();
      pushRow();
    } else if (ch === "\r") {
      // Swallow CR; LF (or end) ends the row.
      if (src[i + 1] === "\n") i += 1;
      pushCell();
      pushRow();
    } else {
      cur += ch;
    }
  }
  // Final cell/row when the file has no trailing newline.
  if (cur.length > 0 || row.length > 0) {
    pushCell();
    pushRow();
  }

  if (table.length === 0) return { columns: [], rows: [] };
  const columns = table[0]!.map((c) => c.trim());
  return { columns, rows: table.slice(1) };
}

function buildPreviews(answers: SurveyImportAnswer[]): SurveyQuestionPreview[] {
  const qMeta = new Map<
    string,
    {
      name: string;
      responses: Map<string, { text: string; count: number; order: number }>;
      multiDays: Set<string>;
      dayResponses: Map<string, Set<string>>;
    }
  >();

  for (const a of answers) {
    let meta = qMeta.get(a.questionExternalId);
    if (!meta) {
      meta = {
        name: a.questionName,
        responses: new Map(),
        multiDays: new Set(),
        dayResponses: new Map(),
      };
      qMeta.set(a.questionExternalId, meta);
    }
    meta.name = a.questionName;
    const existing = meta.responses.get(a.responseExternalId);
    if (existing) {
      existing.count += 1;
      existing.text = a.responseName;
    } else {
      meta.responses.set(a.responseExternalId, {
        text: a.responseName,
        count: 1,
        order: meta.responses.size,
      });
    }
    const dayKey = `${a.personVanId}|${a.canvassedAt.toISOString().slice(0, 10)}`;
    let daySet = meta.dayResponses.get(dayKey);
    if (!daySet) {
      daySet = new Set();
      meta.dayResponses.set(dayKey, daySet);
    }
    daySet.add(a.responseExternalId);
    if (daySet.size > 1) meta.multiDays.add(dayKey);
  }

  return [...qMeta.entries()]
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
}

function parsePhoneDate(raw: string): Date | null {
  const t = Date.parse(raw.trim());
  if (Number.isNaN(t)) return null;
  return new Date(t);
}

function isTruthyCell(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === "yes" || v === "true" || v === "1";
}

/**
 * ScaleToWin phonebank: wide CSV. Person key = Contact VanID (join via VAN ID
 * map). Answer columns start at Canvass Result. `Question [Option]` columns
 * select that option when the cell is Yes/TRUE; plain columns use the cell
 * text as the option. `End` is free text and skipped.
 */
export function parseS2wPhonebank(text: string): SurveyImportParse {
  const { columns, rows: raw } = splitCsv(text);
  const required = [PHONE_PERSON_COL, PHONE_DATE_COL, PHONE_CALL_ID_COL, PHONE_FIRST_ANSWER_COL];
  const missingColumns = required.filter((c) => !columns.includes(c));
  if (missingColumns.length > 0) {
    return {
      ok: false,
      missingColumns,
      rowCount: 0,
      answers: [],
      questions: [],
      rowsSkippedIncomplete: 0,
      rowsSkippedBadDate: 0,
      sampleSkipped: [],
    };
  }

  const personIdx = columns.indexOf(PHONE_PERSON_COL);
  const dateIdx = columns.indexOf(PHONE_DATE_COL);
  const callIdx = columns.indexOf(PHONE_CALL_ID_COL);
  const firstAnswerIdx = columns.indexOf(PHONE_FIRST_ANSWER_COL);

  const answerCols: {
    index: number;
    questionId: string;
    questionName: string;
    fixedOption: string | null;
  }[] = [];
  for (let i = firstAnswerIdx; i < columns.length; i++) {
    const header = columns[i]!;
    if (PHONE_SKIP_COLS.has(header)) continue;
    const m = header.match(OPTION_COL_RE);
    if (m) {
      const questionName = m[1]!.trim();
      const option = m[2]!.trim();
      answerCols.push({
        index: i,
        questionId: questionName,
        questionName,
        fixedOption: option,
      });
    } else {
      answerCols.push({
        index: i,
        questionId: header,
        questionName: header,
        fixedOption: null,
      });
    }
  }

  const answers: SurveyImportAnswer[] = [];
  let rowsSkippedIncomplete = 0;
  let rowsSkippedBadDate = 0;
  const sampleSkipped: SurveyImportParse["sampleSkipped"] = [];

  for (let ri = 0; ri < raw.length; ri++) {
    const cells = raw[ri]!;
    const line = ri + 2;
    const vanId = (cells[personIdx] ?? "").trim();
    const callId = (cells[callIdx] ?? "").trim();
    const dateRaw = (cells[dateIdx] ?? "").trim();
    if (!vanId || !callId) {
      rowsSkippedIncomplete += 1;
      if (sampleSkipped.length < 20) {
        sampleSkipped.push({
          line,
          reason: "incomplete",
          personVanId: vanId,
          questionExternalId: "",
          responseExternalId: "",
          dateRaw,
        });
      }
      continue;
    }
    const canvassedAt = parsePhoneDate(dateRaw);
    if (!canvassedAt) {
      rowsSkippedBadDate += 1;
      if (sampleSkipped.length < 20) {
        sampleSkipped.push({
          line,
          reason: "bad_date",
          personVanId: vanId,
          questionExternalId: "",
          responseExternalId: "",
          dateRaw,
        });
      }
      continue;
    }

    for (const col of answerCols) {
      const cell = (cells[col.index] ?? "").trim();
      if (!cell) continue;

      let responseName: string;
      if (col.fixedOption != null) {
        // Option column: only count when the cell says this option was selected.
        if (!isTruthyCell(cell)) continue;
        responseName = col.fixedOption;
      } else {
        responseName = cell;
      }

      const questionExternalId = col.questionId;
      const responseExternalId = responseName;
      answers.push({
        personVanId: vanId,
        questionExternalId,
        responseExternalId,
        questionName: col.questionName,
        responseName,
        canvassedAt,
        sourceKey: s2wPhonebankResponseKey(callId, questionExternalId, responseExternalId),
      });
    }
  }

  const skippedTotal = rowsSkippedIncomplete + rowsSkippedBadDate;
  if (skippedTotal > 0) {
    console.warn(
      `[s2w-phonebank] skipped ${skippedTotal} row(s)` +
        ` (incomplete=${rowsSkippedIncomplete}, bad_date=${rowsSkippedBadDate})`,
      sampleSkipped,
    );
  }

  const questions = buildPreviews(answers);
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

export function parseS2wPhonebankBytes(buffer: ArrayBuffer): SurveyImportParse {
  return parseS2wPhonebank(new TextDecoder("utf-8").decode(buffer));
}

/**
 * ScaleToWin textbank: only `Tag: Question > Option` columns become answers
 * (TRUE → that option). Bare tags (`Tag: Hostile`) and disposition options
 * hung off a question (`Tag: Campaign Support > Wrong Number`) are skipped.
 * No contact datetime in the export — caller stamps import time on answers.
 */
export function parseS2wTextbank(text: string, respondedAt: Date): SurveyImportParse {
  const { columns, rows: raw } = splitCsv(text);
  const missingColumns = columns.includes(TEXT_PERSON_COL) ? [] : [TEXT_PERSON_COL];
  if (missingColumns.length > 0) {
    return {
      ok: false,
      missingColumns,
      rowCount: 0,
      answers: [],
      questions: [],
      rowsSkippedIncomplete: 0,
      rowsSkippedBadDate: 0,
      sampleSkipped: [],
    };
  }

  const personIdx = columns.indexOf(TEXT_PERSON_COL);
  const tagCols: { index: number; questionId: string; questionName: string; option: string }[] = [];
  for (let i = 0; i < columns.length; i++) {
    const header = columns[i]!;
    if (!header.startsWith(TAG_PREFIX)) continue;
    const rest = header.slice(TAG_PREFIX.length).trim();
    const sep = rest.indexOf(" > ");
    // Require Question > Option; bare tags are not survey responses.
    if (sep < 0) continue;
    const questionName = rest.slice(0, sep).trim();
    const option = rest.slice(sep + 3).trim();
    if (!questionName || !option) continue;
    if (TEXT_SKIP_OPTIONS.has(option.toLowerCase())) continue;
    tagCols.push({
      index: i,
      questionId: questionName,
      questionName,
      option,
    });
  }

  const answers: SurveyImportAnswer[] = [];
  let rowsSkippedIncomplete = 0;
  const sampleSkipped: SurveyImportParse["sampleSkipped"] = [];

  for (let ri = 0; ri < raw.length; ri++) {
    const cells = raw[ri]!;
    const line = ri + 2;
    const vanId = (cells[personIdx] ?? "").trim();
    if (!vanId) {
      rowsSkippedIncomplete += 1;
      if (sampleSkipped.length < 20) {
        sampleSkipped.push({
          line,
          reason: "incomplete",
          personVanId: "",
          questionExternalId: "",
          responseExternalId: "",
          dateRaw: "",
        });
      }
      continue;
    }
    for (const col of tagCols) {
      const cell = (cells[col.index] ?? "").trim();
      if (!isTruthyCell(cell)) continue;
      answers.push({
        personVanId: vanId,
        questionExternalId: col.questionId,
        responseExternalId: col.option,
        questionName: col.questionName,
        responseName: col.option,
        canvassedAt: respondedAt,
        sourceKey: s2wTextbankResponseKey(vanId, col.questionId, col.option),
      });
    }
  }

  if (rowsSkippedIncomplete > 0) {
    console.warn(
      `[s2w-textbank] skipped ${rowsSkippedIncomplete} incomplete row(s)`,
      sampleSkipped,
    );
  }

  return {
    ok: true,
    missingColumns: [],
    rowCount: answers.length,
    answers,
    questions: buildPreviews(answers),
    rowsSkippedIncomplete,
    rowsSkippedBadDate: 0,
    sampleSkipped,
  };
}

export function parseS2wTextbankBytes(buffer: ArrayBuffer, respondedAt: Date): SurveyImportParse {
  return parseS2wTextbank(new TextDecoder("utf-8").decode(buffer), respondedAt);
}

/** Stable dedupe key for one S2W phonebank answer option. */
export function s2wPhonebankResponseKey(
  callId: string,
  questionExternalId: string,
  responseExternalId: string,
): string {
  return `${callId}:${questionExternalId}:${responseExternalId}`;
}

/** Stable dedupe key for one S2W textbank tag (no contact datetime in export). */
export function s2wTextbankResponseKey(
  vanId: string,
  questionExternalId: string,
  responseExternalId: string,
): string {
  return `${vanId}:${questionExternalId}:${responseExternalId}`;
}
