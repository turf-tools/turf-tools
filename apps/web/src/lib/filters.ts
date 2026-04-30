// Filterable fields for segment criteria. Single source of truth
// for the editor UI (which renders inputs by `kind`) and the SQL
// emitter in `criteria-to-sql.ts` (which resolves keys to columns or
// JSONB extracts).

// In-query filter instances
export type EnumFilter = {
  kind: "enum";
  key: string;
  values: string[];
};

export type AgeRangeFilter = {
  kind: "age-range";
  key: string;
  min: number | null;
  max: number | null;
};

export type TextFilter = {
  kind: "text";
  key: string;
  value: string;
};

export type Filter = EnumFilter | AgeRangeFilter | TextFilter;

export type Criteria = { filters: Filter[] };

// Catalog of available filters. `source` tells the SQL translator where
// the field lives (top level "column" or "other_properties").
// `op` on text filters is fixed per-field: names use substring `contains`,
// codes/zips use `equals`. If a field needs both, add it twice (one per op).
export type FilterDef =
  | {
      kind: "enum";
      key: string;
      label: string;
      source: "column" | "other_properties";
      values: ReadonlyArray<{ value: string; label?: string }>;
    }
  | {
      kind: "age-range";
      key: string;
      label: string;
      source: "column" | "other_properties";
    }
  | {
      kind: "text";
      key: string;
      label: string;
      source: "column" | "other_properties";
      op: "equals" | "contains";
    };

export const FILTERS: ReadonlyArray<FilterDef> = [
  // Top-level Person columns
  {
    kind: "text",
    key: "first_name",
    label: "First name",
    source: "column",
    op: "contains",
  },
  {
    kind: "text",
    key: "last_name",
    label: "Last name",
    source: "column",
    op: "contains",
  },
  { kind: "text", key: "zip5", label: "ZIP", source: "column", op: "equals" },

  // other_properties JSONB
  {
    kind: "enum",
    key: "party",
    label: "Party",
    source: "other_properties",
    // NYS BOE enrollment codes. Subset most segments care about; full code
    // list exists upstream and can be extended here as needed.
    values: [
      { value: "DEM", label: "Democrat" },
      { value: "REP", label: "Republican" },
      { value: "WOR", label: "Working Families" },
      { value: "CON", label: "Conservative" },
      { value: "BLK", label: "Blank (no party)" },
      { value: "IND", label: "Independence" },
      { value: "GRE", label: "Green" },
      { value: "LIB", label: "Libertarian" },
      { value: "OTH", label: "Other" },
    ],
  },
  {
    kind: "enum",
    key: "gender",
    label: "Gender",
    source: "other_properties",
    values: [
      { value: "M", label: "Male" },
      { value: "F", label: "Female" },
      { value: "U", label: "Unknown" },
    ],
  },
  {
    kind: "age-range",
    key: "date_of_birth",
    label: "Age",
    source: "other_properties",
  },
  {
    // Composite (assembly_district + election_district) key. Bare ED
    // is repeated across ADs and meaningless on its own; this is what
    // people mean when they say "ED 23-001". Format: "AA-EEE".
    kind: "text",
    key: "ad_ed",
    label: "Election District",
    source: "other_properties",
    op: "equals",
  },
  {
    kind: "text",
    key: "assembly_district",
    label: "Assembly District",
    source: "other_properties",
    op: "equals",
  },
  {
    kind: "text",
    key: "senate_district",
    label: "Senate District",
    source: "other_properties",
    op: "equals",
  },
  {
    kind: "text",
    key: "congressional_district",
    label: "Congressional District",
    source: "other_properties",
    op: "equals",
  },
] as const;

// Helpers
export function definitionFor(key: string): FilterDef | undefined {
  return FILTERS.find((d) => d.key === key);
}

export function emptyFilterFor(def: FilterDef): Filter {
  if (def.kind === "enum") return { kind: "enum", key: def.key, values: [] };
  if (def.kind === "age-range") return { kind: "age-range", key: def.key, min: null, max: null };
  return { kind: "text", key: def.key, value: "" };
}

// True if a filter materially constrains the result set. Empty enum value
// lists, empty text values, and unbounded age ranges all produce no SQL clause
// and thus don't change counts. The editor uses this to skip stale-state
// transitions when adding/removing inactive filters.
export function isActiveFilter(f: Filter): boolean {
  if (f.kind === "enum") return f.values.length > 0;
  if (f.kind === "text") return f.value.trim().length > 0;
  return f.min != null || f.max != null;
}
