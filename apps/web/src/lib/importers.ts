import type { ImportFilter } from "@turf-tools/db/schema";

// One file an importer reads. `onUpdate` is what an Update does with it:
// `replace` reads only what's supplied, `keep` reuses the base version's when
// left blank, `add` adds what's supplied to the base version's.
export type ImporterSource = {
  key: string;
  label: string;
  description: string;
  required: boolean;
  onUpdate: "replace" | "keep" | "add";
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

// Whether the sources can be imported. `base` is the version an Update builds
// on (null on a first import), which lets `keep` and `add` sources stay blank;
// at least one source must be supplied either way.
export function sourcesComplete(
  importer: ImporterSpec,
  sources: Record<string, string>,
  base: number | null,
): boolean {
  const supplied = (s: ImporterSource) => (sources[s.key] ?? "").trim().length > 0;
  return (
    importer.sources.some(supplied) &&
    importer.sources.every(
      (s) => !s.required || supplied(s) || (base != null && s.onUpdate !== "replace"),
    )
  );
}

// The version an Update builds on: the latest ready, unarchived one, when the
// importer has a source to keep or add.
export function updateBase(
  importer: ImporterSpec | null,
  versions: ReadonlyArray<{ versionNumber: number; status: string; isArchived: boolean }>,
): number | null {
  if (!importer?.sources.some((s) => s.onUpdate !== "replace")) return null;
  const ready = versions.filter((v) => v.status === "ready" && !v.isArchived);
  return ready.length > 0 ? Math.max(...ready.map((v) => v.versionNumber)) : null;
}

// What an Update does with a source, as a clause after its description.
export function updateHint(source: ImporterSource, base: number | null): string | null {
  if (base == null) return null;
  const label = source.label.toLowerCase();
  if (source.onUpdate === "keep") return `if blank uses v${base} ${label}`;
  if (source.onUpdate === "add") return `adds to ${label} from v${base}`;
  return null;
}

// What a version that built on another took from it, e.g. "Voter file from v3
// unchanged and voter history from v3 with additions."; null for one built
// from its own sources alone.
export function builtOnLabel(
  importer: ImporterSpec | null,
  sources: Record<string, string>,
  base: number | null,
): string | null {
  if (base == null) return null;
  const parts = (importer?.sources ?? []).flatMap((s) => {
    const supplied = (sources[s.key] ?? "").trim().length > 0;
    if (s.onUpdate === "keep")
      return [supplied ? `${s.label} updated` : `${s.label} from v${base} unchanged`];
    if (s.onUpdate === "add")
      return [`${s.label} from v${base} ${supplied ? "with additions" : "unchanged"}`];
    return [];
  });
  if (parts.length === 0) return null;
  const [first, ...rest] = parts;
  return `${[first, ...rest.map((p) => p.charAt(0).toLowerCase() + p.slice(1))].join(" and ")}.`;
}
