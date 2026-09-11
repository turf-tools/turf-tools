import type { ImportFilter } from "@turf-tools/db/schema";

// A source column an import filter may fix a dataset to. Values are the
// file's own codes.
export type ImportFilterField = { column: string; label: string };

// Mirrors `NysVoterFileImporter.FILTER_COLUMNS` (decoded source column names).
const NYS_FILTER_FIELDS: ReadonlyArray<ImportFilterField> = [
  { column: "congressional_district", label: "Congressional district" },
  { column: "assembly_district", label: "Assembly district" },
  { column: "senate_district", label: "Senate district" },
  { column: "county_code", label: "County" },
  { column: "res_zip5", label: "ZIP code" },
];

// Curated importers available in the import picker, mirroring the data-side
// registry (apps/data/src/importers). Will become an `importers.list` rpc once
// generic (mapping-driven) importers need runtime config.
export const AVAILABLE_IMPORTERS = [
  { name: "nys_voter_file", label: "New York State Voter File", filters: NYS_FILTER_FIELDS },
] as const;

export type ImporterName = (typeof AVAILABLE_IMPORTERS)[number]["name"];

export function importerLabel(name: string): string {
  return AVAILABLE_IMPORTERS.find((i) => i.name === name)?.label ?? name;
}

export function importFilterFields(importer: string): ReadonlyArray<ImportFilterField> {
  return AVAILABLE_IMPORTERS.find((i) => i.name === importer)?.filters ?? [];
}

// "Congressional district 13"; null when the dataset imports the whole source.
export function importFilterLabel(importer: string, filter: ImportFilter | null | undefined) {
  if (!filter || filter.values.length === 0) return null;
  const field = importFilterFields(importer).find((f) => f.column === filter.column);
  return `${field?.label ?? filter.column} ${filter.values.join(", ")}`;
}
