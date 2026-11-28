import { expect, test } from "vite-plus/test";
import {
  parseS2wPhonebank,
  parseS2wTextbank,
  s2wPhonebankResponseKey,
  s2wTextbankResponseKey,
} from "../src/lib/s2w-import";

const PHONEBANK = [
  [
    "Call ID",
    "Call Date/Time",
    "Contact VanID",
    "Contact First Name",
    "Canvass Result",
    "Top Issue?",
    "Would you like to support the campaign by volunteering? [Yes]",
    "Would you like to support the campaign by volunteering? [No]",
    "End",
  ].join(","),
  [
    "call-1",
    "2026-06-04T22:58:50.071Z",
    "1410023",
    "Montrez",
    "Talking to Correct Person",
    "Housing",
    "Yes",
    "No",
    "some note",
  ].join(","),
  ["call-2", "not-a-date", "14765132", "Molly", "Refused", "", "No", "Yes", ""].join(","),
  ["call-3", "2026-06-09T16:18:04.856Z", "", "Nobody", "Refused", "", "", "", ""].join(","),
].join("\n");

const TEXTBANK = [
  [
    "Campaign ID",
    "Contact Script",
    "van_id",
    "Tag: Campaign Support > 1 - Strong Support",
    "Tag: Campaign Support > 3 - Undecided",
    "Tag: Campaign Support > Wrong Number",
    "Tag: Hostile",
  ].join(","),
  // Multiline quoted script must not split the row.
  ["c1", '"Hello,\nfriend!"', "2678171", "TRUE", "FALSE", "TRUE", "FALSE"].join(","),
  ["c1", '""', "2678172", "FALSE", "TRUE", "FALSE", "TRUE"].join(","),
  ["c1", '""', "", "TRUE", "FALSE", "FALSE", "FALSE"].join(","),
].join("\n");

test("parses S2W phonebank wide answers", () => {
  const parsed = parseS2wPhonebank(PHONEBANK);
  expect(parsed.ok).toBe(true);
  expect(parsed.rowsSkippedBadDate).toBe(1);
  expect(parsed.rowsSkippedIncomplete).toBe(1);
  // call-1: Canvass Result, Top Issue, volunteering Yes — End skipped
  expect(parsed.answers.map((a) => a.responseName).sort()).toEqual([
    "Housing",
    "Talking to Correct Person",
    "Yes",
  ]);
  expect(parsed.answers[0]!.sourceKey).toBe(
    s2wPhonebankResponseKey("call-1", "Canvass Result", "Talking to Correct Person"),
  );
  const volunteer = parsed.questions.find(
    (q) => q.questionExternalId === "Would you like to support the campaign by volunteering?",
  );
  expect(volunteer?.responses.map((r) => r.text)).toEqual(["Yes"]);
});

test("parses S2W textbank Question > Option tags; skips disposition options", () => {
  const at = new Date("2026-11-27T12:00:00.000Z");
  const parsed = parseS2wTextbank(TEXTBANK, at);
  expect(parsed.ok).toBe(true);
  expect(parsed.rowsSkippedIncomplete).toBe(1);
  expect(parsed.answers).toHaveLength(2);
  expect(parsed.answers.every((a) => a.canvassedAt.toISOString() === at.toISOString())).toBe(true);
  expect(parsed.questions.map((q) => q.questionExternalId)).toEqual(["Campaign Support"]);
  const support = parsed.questions.find((q) => q.questionExternalId === "Campaign Support");
  expect(support?.responses.map((r) => r.text).sort()).toEqual([
    "1 - Strong Support",
    "3 - Undecided",
  ]);
  expect(parsed.answers.some((a) => a.responseName === "Wrong Number")).toBe(false);
  expect(parsed.answers.some((a) => a.questionExternalId === "Hostile")).toBe(false);
  expect(parsed.answers[0]!.sourceKey).toBe(
    s2wTextbankResponseKey("2678171", "Campaign Support", "1 - Strong Support"),
  );
});
