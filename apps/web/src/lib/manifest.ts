// The dataset field manifest — the per-version catalog of filterable fields,
// authored by the importer on the data side (apps/data/src/importers/base.py:
// Manifest/FieldDef) and persisted to `dataset_versions.manifest`. The web reads
// it to render the segment/zone editors, replacing the old hardcoded
// `FILTER_SECTIONS`/`KEY_GROUPS_AVAILABLE` catalogs.
//
// Shape mirrors the Pydantic model's JSON serialization, which is snake_case.
// `fields` is a list of *sections* (each an inner list) — the grouping the
// editor renders with separators between; the structure is the grouping.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type FilterDef, SYSTEM_BOTTOM_SECTIONS, SYSTEM_TOP_SECTION } from "~/lib/filters";
import { manifestQuery } from "~/lib/queries/manifest";

export type ManifestFilterKind =
  | "text"
  | "enum"
  | "text-multi"
  | "age-range"
  | "date-range"
  | "voting-history-count"
  | "address";

export type ManifestEnumValue = { value: string; label?: string | null };

export type ManifestFieldDef = {
  column: string;
  label: string;
  filterKind: ManifestFilterKind;
  values?: ManifestEnumValue[] | null;
  keyGroup?: string | null;
  keyGroupLabel?: string | null;
};

export type Manifest = { fields: ManifestFieldDef[][] };

// Map one manifest field to its editor `FilterDef`. Mirrors the data-side
// `build_field_catalog` — `filterKind` matches the `FilterDef` kind 1:1, so
// this is near-identity.
function fieldToFilterDef(fd: ManifestFieldDef): FilterDef {
  const label = fd.label;
  switch (fd.filterKind) {
    case "text":
      return { kind: "text", key: fd.column, label };
    case "enum":
      return {
        kind: "enum",
        key: fd.column,
        label,
        values: (fd.values ?? []).map((v) => ({ value: v.value, label: v.label ?? undefined })),
      };
    case "text-multi":
      return { kind: "text-multi", key: fd.column, label };
    case "age-range":
      return { kind: "age-range", key: fd.column, label };
    case "date-range":
      return { kind: "date-range", key: fd.column, label };
    case "voting-history-count":
      return { kind: "voting-history-count", key: fd.column, label };
    case "address":
      return { kind: "address", key: "address", label };
  }
}

export type KeyGroupOption = { value: string; label: string };

export type FilterCatalog = {
  // Sections for the "add filter" dropdown: `all` on top, the manifest's field
  // sections, then canvass + segment.
  sections: ReadonlyArray<ReadonlyArray<FilterDef>>;
  definitionFor: (key: string) => FilterDef | undefined;
  // Boundary key groups this dataset supports (zone editor), derived from the
  // fields carrying a `key_group`.
  keyGroups: KeyGroupOption[];
};

export function buildFilterCatalog(manifest: Manifest | null): FilterCatalog {
  const fieldSections = (manifest?.fields ?? [])
    .map((section) => section.map(fieldToFilterDef))
    .filter((s) => s.length > 0);
  const sections = [SYSTEM_TOP_SECTION, ...fieldSections, ...SYSTEM_BOTTOM_SECTIONS];

  const byKey = new Map<string, FilterDef>();
  for (const section of sections) for (const def of section) byKey.set(def.key, def);

  const keyGroups: KeyGroupOption[] = [];
  for (const section of manifest?.fields ?? []) {
    for (const fd of section) {
      if (fd.keyGroup)
        keyGroups.push({ value: fd.keyGroup, label: fd.keyGroupLabel ?? fd.keyGroup });
    }
  }

  return { sections, definitionFor: (key) => byKey.get(key), keyGroups };
}

// Fetches the org's active-dataset manifest and derives the editor catalog.
// Cached hard (immutable per version), so calling this from several components
// shares one fetch. Before the manifest loads (or with no active dataset) the
// catalog is system-filters-only.
export function useFilterCatalog(): FilterCatalog & { isLoading: boolean } {
  const { data, isLoading } = useQuery(manifestQuery());
  const catalog = useMemo(() => buildFilterCatalog(data?.manifest ?? null), [data]);
  return { ...catalog, isLoading };
}
