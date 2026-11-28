import { expect, test } from "vite-plus/test";
import {
  decodeVanExportBytes,
  parseVanDate,
  parseVanIdMap,
  parseVanIdMapBytes,
  parseVanSurveyExport,
  parseVanSurveyExportBytes,
  vanImportedResponseKey,
} from "../src/lib/van-import";

function utf16Le(text: string): ArrayBuffer {
  const buf = new ArrayBuffer(2 + text.length * 2);
  const view = new DataView(buf);
  view.setUint8(0, 0xff);
  view.setUint8(1, 0xfe);
  for (let i = 0; i < text.length; i++) {
    view.setUint16(2 + i * 2, text.charCodeAt(i), true);
  }
  return buf;
}

const ID_MAP = [
  "StateFileID\tVoter File VANID\tPreferred Phone",
  '08865190\t10426746\t="5627196521"',
  '02650896\t10427191\t="4049310140"',
].join("\r\n");

const SURVEY = [
  [
    "Voter File VANID",
    "FirstName",
    "SurveyQuestionId",
    "SurveyResponseId",
    "SurveyQuestionType",
    "SurveyQuestionLongName",
    "SurveyResponseName",
    "DateCanvassed",
  ].join("\t"),
  [
    "10426746",
    "Ashley",
    "727137",
    "2916960",
    "Candidate",
    "Runoff ID",
    "2 - Lean Support",
    "05/30/2026",
  ].join("\t"),
  ["10426746", "Ashley", "741536", "2975407", "Issue", "Heard Of Runoff", "Yes", "05/30/2026"].join(
    "\t",
  ),
  [
    "10427191",
    "Leroy",
    "727137",
    "2916959",
    "Candidate",
    "Runoff ID",
    "1 - Strong Support",
    "06/14/2026",
  ].join("\t"),
  // Same person/day, two Top Issues → multi_select
  ["10427191", "Leroy", "726976", "2916322", "Issue", "Top Issues", "Housing", "06/14/2026"].join(
    "\t",
  ),
  ["10427191", "Leroy", "726976", "2916325", "Issue", "Top Issues", "Economy", "06/14/2026"].join(
    "\t",
  ),
].join("\r\n");

test("parses UTF-16 LE ID map", () => {
  const parsed = parseVanIdMapBytes(utf16Le(ID_MAP));
  expect(parsed.ok).toBe(true);
  expect(parsed.rowCount).toBe(2);
  expect(parsed.rows[0]).toEqual({ stateFileId: "08865190", vanId: "10426746" });
});

test("ID map requires StateFileID and VANID", () => {
  const parsed = parseVanIdMap("Foo\tBar\n1\t2");
  expect(parsed.ok).toBe(false);
  expect(parsed.missingColumns).toEqual(["StateFileID", "Voter File VANID"]);
});

test("parses survey results export", () => {
  const parsed = parseVanSurveyExportBytes(utf16Le(SURVEY));
  expect(parsed.ok).toBe(true);
  expect(parsed.rowCount).toBe(5);
  expect(parsed.questions.map((q) => q.questionExternalId).sort()).toEqual([
    "726976",
    "727137",
    "741536",
  ]);
  const runoff = parsed.questions.find((q) => q.questionExternalId === "727137")!;
  expect(runoff.name).toBe("Runoff ID");
  expect(runoff.multiSelect).toBe(false);
  expect(runoff.responses).toEqual([
    { responseExternalId: "2916960", text: "2 - Lean Support", count: 1 },
    { responseExternalId: "2916959", text: "1 - Strong Support", count: 1 },
  ]);
  const issues = parsed.questions.find((q) => q.questionExternalId === "726976")!;
  expect(issues.multiSelect).toBe(true);
  expect(parsed.answers[0]!.canvassedAt.toISOString()).toBe("2026-05-30T12:00:00.000Z");
});

test("UTF-8 survey parse works the same", () => {
  expect(parseVanSurveyExport(SURVEY).rowCount).toBe(5);
});

test("tracks incomplete and bad-date survey rows", () => {
  const withBad = [
    SURVEY,
    [
      "10426746",
      "Ashley",
      "727137",
      "2916960",
      "Candidate",
      "Runoff ID",
      "2 - Lean Support",
      "not-a-date",
    ].join("\t"),
    [
      "",
      "Ashley",
      "727137",
      "2916960",
      "Candidate",
      "Runoff ID",
      "2 - Lean Support",
      "05/30/2026",
    ].join("\t"),
  ].join("\r\n");
  const parsed = parseVanSurveyExport(withBad);
  expect(parsed.ok).toBe(true);
  expect(parsed.rowCount).toBe(5);
  expect(parsed.rowsSkippedBadDate).toBe(1);
  expect(parsed.rowsSkippedIncomplete).toBe(1);
  expect(parsed.sampleSkipped).toEqual([
    {
      line: 7,
      reason: "bad_date",
      personVanId: "10426746",
      questionExternalId: "727137",
      responseExternalId: "2916960",
      dateRaw: "not-a-date",
    },
    {
      line: 8,
      reason: "incomplete",
      personVanId: "",
      questionExternalId: "727137",
      responseExternalId: "2916960",
      dateRaw: "05/30/2026",
    },
  ]);
});

test("decodeVanExportBytes detects UTF-16", () => {
  const text = decodeVanExportBytes(utf16Le("StateFileID\tVoter File VANID\n1\t2"));
  expect(text.startsWith("StateFileID")).toBe(true);
});

test("parseVanDate handles M/D/YYYY", () => {
  expect(parseVanDate("5/30/2026")?.toISOString()).toBe("2026-05-30T12:00:00.000Z");
  expect(parseVanDate("bogus")).toBeNull();
});

test("vanImportedResponseKey is stable", () => {
  const a = vanImportedResponseKey(
    "10426746",
    new Date("2026-05-30T12:00:00.000Z"),
    "727137",
    "2916960",
  );
  expect(a).toBe("10426746:2026-05-30:727137:2916960");
});
