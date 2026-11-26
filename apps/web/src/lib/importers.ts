import type { ImportFilter } from "@turf-tools/db/schema";

// One file an importer reads.
export type ImporterSource = {
  key: string;
  label: string;
  description: string;
  required: boolean;
};

// A source column an import filter may fix a dataset to. Values are the
// file's own codes.
export type ImporterFilter = { column: string; label: string };

// An importer as the data server's registry describes it (`GET /importers`,
// `ImporterSpec` in apps/data/src/importers/base.py).
export type ImporterSpec = {
  name: string;
  label: string;
  sources: ImporterSource[];
  filters: ImporterFilter[];
};

export function findImporter(importers: ReadonlyArray<ImporterSpec>, name: string) {
  return importers.find((i) => i.name === name) ?? null;
}

export function importerLabel(importers: ReadonlyArray<ImporterSpec>, name: string): string {
  return findImporter(importers, name)?.label ?? name;
}

// "Congressional district 13"; null when the dataset imports the whole source.
export function importFilterLabel(
  importer: ImporterSpec | null,
  filter: ImportFilter | null | undefined,
) {
  if (!filter || filter.values.length === 0) return null;
  const field = importer?.filters.find((f) => f.column === filter.column);
  return `${field?.label ?? filter.column} ${filter.values.join(", ")}`;
}

// Trimmed, non-empty entries only, so an untouched optional input isn't sent.
export function cleanSources(sources: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sources)
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([, v]) => v.length > 0),
  );
}

// An http(s) link, or a path on the data server (mirrors the data side's
// `is_readable_source`). Other URL schemes (s3://, …) are refused: the server
// holds no credentials for them.
export function isReadableSource(source: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(source.trim())?.[1]?.toLowerCase();
  return scheme === undefined || scheme === "http" || scheme === "https";
}

export function sourcesComplete(importer: ImporterSpec, sources: Record<string, string>): boolean {
  return importer.sources.every((s) => !s.required || (sources[s.key] ?? "").trim().length > 0);
}
