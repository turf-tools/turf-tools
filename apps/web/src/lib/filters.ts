// Filterable fields for segment criteria. Single source of truth
// for the editor UI (which renders inputs by `kind`) and the SQL
// emitter in `criteria-to-sql.ts` (which resolves keys to columns or
// JSONB extracts).

// In-query filter instances
export type AllFilter = { kind: "all" };

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

export type Filter = AllFilter | EnumFilter | AgeRangeFilter | TextFilter;

// Criteria — ordered sequence of steps with verbs.
export type Verb = "add" | "narrow" | "remove";
export type Step = { id: string; verb: Verb; filter: Filter };
export type Criteria = { steps: Step[] };

// Catalog of available filters. `source` tells the SQL translator where
// the field lives (top level "column" or "other_properties").
// `op` on text filters is fixed per-field: names use substring `contains`,
// codes/zips use `equals`. If a field needs both, add it twice (one per op).
export type FilterDef =
  | { kind: "all"; key: "all"; label: string }
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
  // Special
  { kind: "all", key: "all", label: "Everyone" },

  // Top-level Person columns
  { kind: "text", key: "first_name", label: "First name", source: "column", op: "contains" },
  { kind: "text", key: "last_name", label: "Last name", source: "column", op: "contains" },
  { kind: "text", key: "zip5", label: "ZIP", source: "column", op: "equals" },

  // other_properties JSONB
  {
    kind: "enum",
    key: "enrollment",
    label: "Party",
    source: "other_properties",
    values: [
      { value: "democratic", label: "Democratic" },
      { value: "republican", label: "Republican" },
      { value: "conservative", label: "Conservative" },
      { value: "working_families", label: "Working Families" },
      { value: "unaffiliated", label: "Unaffiliated" },
      { value: "independence", label: "Independence" },
      { value: "green", label: "Green" },
      { value: "libertarian", label: "Libertarian" },
      { value: "reform", label: "Reform" },
      { value: "other", label: "Other" },
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
  { kind: "age-range", key: "date_of_birth", label: "Age", source: "other_properties" },
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
export function filterKey(f: Filter): string {
  return f.kind === "all" ? "all" : f.key;
}

export function definitionFor(key: string): FilterDef | undefined {
  return FILTERS.find((d) => d.key === key);
}

export function emptyFilterFor(def: FilterDef): Filter {
  if (def.kind === "all") return { kind: "all" };
  if (def.kind === "enum") return { kind: "enum", key: def.key, values: [] };
  if (def.kind === "age-range") return { kind: "age-range", key: def.key, min: null, max: null };
  return { kind: "text", key: def.key, value: "" };
}

// True if a filter materially constrains (or expands) the result set.
export function isActiveFilter(f: Filter): boolean {
  if (f.kind === "all") return true;
  if (f.kind === "enum") return f.values.length > 0;
  if (f.kind === "text") return f.value.trim().length > 0;
  return f.min != null || f.max != null;
}

export function isActiveStep(s: Step): boolean {
  return isActiveFilter(s.filter);
}

// Verb display metadata — label and accent color.
export const VERB_META: Record<Verb, { label: string; color: string }> = {
  narrow: { label: "Narrow", color: "#4269d0" },
  add: { label: "Add", color: "#3ca951" },
  remove: { label: "Remove", color: "#ff725c" },
};
