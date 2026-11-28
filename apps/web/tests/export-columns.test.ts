import { test, expect } from "vite-plus/test";
import { exportColumns, PEOPLE_DEFAULT } from "../src/lib/export-columns";
import type { Manifest } from "../src/lib/manifest";

const MANIFEST: Manifest = {
  fields: [
    [
      { column: "first_name", label: "First Name", filterKind: "text" },
      { key: "address", label: "Address", filterKind: "address" },
      { column: "enrollment", label: "Party", filterKind: "enum" },
    ],
    [
      { column: "date_of_birth", label: "Age", filterKind: "age-range" },
      {
        column: "voting_history",
        key: "voting_history_count",
        label: "Voting History Count",
        filterKind: "voting-history-count",
      },
    ],
  ],
};

test("people columns are the core list then the dataset's own fields", () => {
  const { people } = exportColumns(MANIFEST);
  expect(people.slice(0, PEOPLE_DEFAULT.length).map((c) => c.key)).toEqual(PEOPLE_DEFAULT);
  expect(people.slice(PEOPLE_DEFAULT.length)).toEqual([
    { key: "enrollment", label: "Party" },
    { key: "date_of_birth", label: "Date of Birth" },
  ]);
});

test("no manifest still offers the core and household columns", () => {
  const columns = exportColumns(null);
  expect(columns.people.map((c) => c.key)).toEqual(PEOPLE_DEFAULT);
  expect(columns.households[0]).toEqual({ key: "household_name", label: "Household Name" });
});
