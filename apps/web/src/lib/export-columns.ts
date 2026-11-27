// Columns the segment export dialog offers. Mirrors the data side's lists
// (apps/data/src/segment_export.py), which also validates every request and
// drops optional core columns a dataset doesn't have.

import type { Manifest } from "~/lib/manifest";

export type ExportRows = "people" | "households";
export type ExportFormat = "csv" | "excel" | "parquet";
export type ExportColumn = { key: string; label: string };
export type ExportColumns = Record<ExportRows, ExportColumn[]>;

// xlsx caps a sheet at 1,048,576 rows, one of which is the header.
export const EXCEL_MAX_ROWS = 1_048_575;

// `EXPORT_COLUMNS` in apps/data/src/models.py; also the People default.
const CORE_COLUMNS: ExportColumn[] = [
  { key: "external_id", label: "Voter ID" },
  { key: "external_id_type", label: "Voter ID Type" },
  { key: "first_name", label: "First Name" },
  { key: "middle_name", label: "Middle Name" },
  { key: "last_name", label: "Last Name" },
  { key: "name_suffix", label: "Suffix" },
  { key: "address_line_1", label: "Address" },
  { key: "address_line_2", label: "Unit" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip5", label: "ZIP" },
  { key: "zip4", label: "ZIP+4" },
  { key: "latitude", label: "Latitude" },
  { key: "longitude", label: "Longitude" },
];

const HOUSEHOLD_COLUMNS: ExportColumn[] = [
  { key: "household_name", label: "Household Name" },
  { key: "person_count", label: "People" },
  { key: "address_line_1", label: "Address" },
  { key: "address_line_2", label: "Unit" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip5", label: "ZIP" },
  { key: "latitude", label: "Latitude" },
  { key: "longitude", label: "Longitude" },
];

export const PEOPLE_DEFAULT = CORE_COLUMNS.map((c) => c.key);

export function exportColumns(manifest: Manifest | null): ExportColumns {
  const people = [...CORE_COLUMNS];
  for (const fd of manifest?.fields.flat() ?? []) {
    // Voting history is a list per person; it has no single cell value.
    if (!fd.column || fd.filterKind.startsWith("voting-history")) continue;
    if (people.some((c) => c.key === fd.column)) continue;
    // An age filter reads date_of_birth; the export holds the date itself.
    const label = fd.filterKind === "age-range" ? "Date of Birth" : fd.label;
    people.push({ key: fd.column, label });
  }
  return { people, households: HOUSEHOLD_COLUMNS };
}
