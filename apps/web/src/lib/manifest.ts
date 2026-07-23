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
import { customFieldsQuery } from "~/lib/queries/custom-fields";

export type ManifestFilterKind =
  | "text"
  | "enum"
  | "text-multi"
  | "age-range"
  | "date-range"
  | "voting-history-count"
  | "voting-history-detail"
  | "address";

export type ManifestEnumValue = { value: string; label?: string | null };

export type ManifestFieldDef = {
  // Physical column this field reads; absent for a column-less composite
  // (`address`). `key` is the field identifier, defaulting to `column`; set
  // explicitly to disambiguate two filters over one column (voting_history).
  column?: string | null;
  key?: string | null;
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
  // Field identifier: explicit `key`, else the column (mirrors the data side's
  // `FieldDef.identifier`). A field with neither is malformed.
  const key = fd.key ?? fd.column ?? "";
  switch (fd.filterKind) {
    case "text":
      return { kind: "text", key, label };
    case "enum":
      return {
        kind: "enum",
        key,
        label,
        values: (fd.values ?? []).map((v) => ({ value: v.value, label: v.label ?? undefined })),
      };
    case "text-multi":
      return { kind: "text-multi", key, label };
    case "age-range":
      return { kind: "age-range", key, label };
    case "date-range":
      return { kind: "date-range", key, label };
    case "voting-history-count":
      return { kind: "voting-history-count", key, label };
    case "voting-history-detail":
      return { kind: "voting-history-detail", key, label };
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

export type CustomFieldOption = {
  customFieldId: string;
  label: string;
  fieldType: "number" | "date" | "text" | "enum";
  values: string[] | null;
  isArchived: boolean;
};

// Custom fields become ordinary defs (enum/text/date-range/number-range)
// keyed by field id, so the standard editors work against them unchanged.
function customFieldToFilterDef(f: CustomFieldOption): FilterDef {
  if (f.fieldType === "enum")
    return {
      kind: "enum",
      key: f.customFieldId,
      label: f.label,
      values: (f.values ?? []).map((v) => ({ value: v })),
    };
  if (f.fieldType === "date") return { kind: "date-range", key: f.customFieldId, label: f.label };
  if (f.fieldType === "text") return { kind: "text", key: f.customFieldId, label: f.label };
  return { kind: "number-range", key: f.customFieldId, label: f.label };
}

export function buildFilterCatalog(
  manifest: Manifest | null,
  customFields: CustomFieldOption[] = [],
): FilterCatalog {
  const fieldSections = (manifest?.fields ?? [])
    .map((section) => section.map(fieldToFilterDef))
    .filter((s) => s.length > 0);
  // Archived custom fields stay resolvable (saved segments reference them by
  // id) but drop out of the picker; definitionFor sees every def in
  // `sections`, and the picker renders the same sections, so archived defs
  // are resolved through `archivedDefs` below instead.
  const customSection = customFields.filter((f) => !f.isArchived).map(customFieldToFilterDef);
  const archivedDefs = customFields.filter((f) => f.isArchived).map(customFieldToFilterDef);
  const sections = [
    SYSTEM_TOP_SECTION,
    ...fieldSections,
    ...(customSection.length > 0 ? [customSection] : []),
    ...SYSTEM_BOTTOM_SECTIONS,
  ];

  const byKey = new Map<string, FilterDef>();
  for (const section of sections) for (const def of section) byKey.set(def.key, def);
  for (const def of archivedDefs) byKey.set(def.key, def);

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
  const { data: customFields } = useQuery(customFieldsQuery());
  const catalog = useMemo(
    () => buildFilterCatalog(data?.manifest ?? null, customFields ?? []),
    [data, customFields],
  );
  return { ...catalog, isLoading };
}
