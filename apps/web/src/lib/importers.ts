// Curated importers available in the import picker, mirroring the data-side
// registry (apps/data/src/importers). Will become an `importers.list` rpc once
// generic (mapping-driven) importers need runtime config.
export const AVAILABLE_IMPORTERS = [
  { name: "nys_voter_file", label: "New York State Voter File" },
] as const;

export type ImporterName = (typeof AVAILABLE_IMPORTERS)[number]["name"];

export function importerLabel(name: string): string {
  return AVAILABLE_IMPORTERS.find((i) => i.name === name)?.label ?? name;
}
