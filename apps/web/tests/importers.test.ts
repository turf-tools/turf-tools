import { expect, test } from "vite-plus/test";
import {
  builtOnLabel,
  type ImporterSpec,
  isReadableSource,
  sourcesComplete,
  updateBase,
  updateHint,
} from "../src/lib/importers";

test("http(s) links and local paths are readable", () => {
  expect(isReadableSource("https://example.com/voters.parquet")).toBe(true);
  expect(isReadableSource("http://example.com/voters.parquet")).toBe(true);
  expect(isReadableSource("/data/voters.parquet")).toBe(true);
  expect(isReadableSource("~/fixtures/voters.parquet")).toBe(true);
  expect(isReadableSource("")).toBe(true);
});

test("other URL schemes are not", () => {
  expect(isReadableSource("s3://bucket/voters.parquet")).toBe(false);
  expect(isReadableSource("gs://bucket/voters.parquet")).toBe(false);
});

const georgia: ImporterSpec = {
  name: "ga_voter_file",
  label: "Georgia Voter File",
  filters: [],
  sources: [
    { key: "file", label: "Voter file", description: "", required: true, onUpdate: "keep" },
    { key: "history", label: "Voter history", description: "", required: false, onUpdate: "add" },
  ],
};
const florida: ImporterSpec = {
  ...georgia,
  name: "fl_voter_file",
  sources: georgia.sources.map((s) => ({ ...s, onUpdate: "replace" as const })),
};

test("an update builds on the latest ready, unarchived version", () => {
  const versions = [
    { versionNumber: 4, status: "failed", isArchived: false },
    { versionNumber: 3, status: "ready", isArchived: true },
    { versionNumber: 2, status: "ready", isArchived: false },
    { versionNumber: 1, status: "ready", isArchived: false },
  ];
  expect(updateBase(georgia, versions)).toBe(2);
  expect(updateBase(florida, versions)).toBe(null);
  expect(updateBase(georgia, [])).toBe(null);
});

test("a kept source may stay blank only on an update, and something must be supplied", () => {
  expect(sourcesComplete(georgia, { history: "h.csv" }, null)).toBe(false);
  expect(sourcesComplete(georgia, { history: "h.csv" }, 2)).toBe(true);
  expect(sourcesComplete(georgia, { file: " ", history: "" }, 2)).toBe(false);
  expect(sourcesComplete(florida, { history: "h.zip" }, 2)).toBe(false);
});

test("a version built on another says what it took from it", () => {
  expect(builtOnLabel(georgia, { history: "h.csv" }, 3)).toBe(
    "Voter file from v3 unchanged and voter history from v3 with additions.",
  );
  expect(builtOnLabel(georgia, { file: "f.csv", history: "h.csv" }, 3)).toBe(
    "Voter file updated and voter history from v3 with additions.",
  );
  expect(builtOnLabel(georgia, { file: "f.csv" }, 3)).toBe(
    "Voter file updated and voter history from v3 unchanged.",
  );
  expect(builtOnLabel(georgia, { file: "f.csv" }, null)).toBe(null);
  expect(builtOnLabel(florida, { detail: "d.zip" }, 3)).toBe(null);
});

test("update hints name the base version", () => {
  expect(updateHint(georgia.sources[0]!, 3)).toBe("if blank uses v3 voter file");
  expect(updateHint(georgia.sources[1]!, 3)).toBe("adds to voter history from v3");
  expect(updateHint(georgia.sources[1]!, null)).toBe(null);
  expect(updateHint(florida.sources[1]!, 3)).toBe(null);
});
