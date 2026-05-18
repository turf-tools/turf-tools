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

export type DateRangeFilter = {
  kind: "date-range";
  key: string;
  min: string | null; // ISO 8601 YYYY-MM-DD
  max: string | null;
};

export type VotingHistoryFilter = {
  kind: "voting-history-count";
  key: string;
  type: "primary" | "general";
  windowYears: number;
  comparator: "at_least" | "exactly";
  count: number;
};

// Single UI element, multiple underlying columns. Each sub-field is
// optional; compilation AND-joins clauses for whichever are filled.
export type AddressFilter = {
  kind: "address";
  key: "address";
  line1: string;
  city: string;
  state: string;
  zip: string;
};

export type Filter =
  | AllFilter
  | EnumFilter
  | AgeRangeFilter
  | TextFilter
  | DateRangeFilter
  | VotingHistoryFilter
  | AddressFilter;

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
    }
  | {
      kind: "date-range";
      key: string;
      label: string;
      source: "column" | "other_properties";
    }
  | {
      kind: "voting-history-count";
      key: string;
      label: string;
      source: "column";
    }
  | {
      kind: "address";
      key: "address";
      label: string;
    };

// Catalog organized into sections — the editor's "add filter" dropdown
// renders a separator between each group. Keep the flat FILTERS export
// derived from this so other consumers (definitionFor, etc.) don't care.
export const FILTER_SECTIONS: ReadonlyArray<ReadonlyArray<FilterDef>> = [
  // Special — only `narrow` shows this section (handled in the dropdown).
  [{ kind: "all", key: "all", label: "Everyone" }],
  // Identity + demographics
  [
    { kind: "text", key: "first_name", label: "First name", source: "column", op: "contains" },
    { kind: "text", key: "last_name", label: "Last name", source: "column", op: "contains" },
    { kind: "address", key: "address", label: "Address" },
    {
      // The field is canonical (`county_code`) but the enum values are
      // state-local. NYC: 5 NYS-BOE county codes → borough names.
      kind: "enum",
      key: "county_code",
      label: "County",
      source: "column",
      values: [
        { value: "03", label: "Bronx" },
        { value: "24", label: "Kings" },
        { value: "31", label: "New York" },
        { value: "41", label: "Queens" },
        { value: "43", label: "Richmond" },
      ],
    },
    {
      kind: "enum",
      key: "gender",
      label: "Gender",
      source: "column",
      values: [
        { value: "M", label: "Male" },
        { value: "F", label: "Female" },
        { value: "U", label: "Unknown" },
      ],
    },
    { kind: "age-range", key: "date_of_birth", label: "Age", source: "column" },
  ],
  // Geographic divisions
  [
    { kind: "text", key: "precinct", label: "Precint", source: "column", op: "equals" },
    {
      kind: "text",
      key: "assembly_district",
      label: "Assembly District",
      source: "column",
      op: "equals",
    },
    {
      kind: "text",
      key: "senate_district",
      label: "Senate District",
      source: "column",
      op: "equals",
    },
    {
      kind: "text",
      key: "congressional_district",
      label: "Congressional District",
      source: "column",
      op: "equals",
    },
  ],
  // Voter behavior
  [
    {
      kind: "enum",
      key: "enrollment",
      label: "Party",
      source: "column",
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
    { kind: "date-range", key: "registration_date", label: "Registration Date", source: "column" },
    {
      kind: "enum",
      key: "registration_status",
      label: "Registration Status",
      source: "column",
      values: [
        { value: "active", label: "Active" },
        { value: "inactive", label: "Inactive" },
        { value: "federal_only", label: "Federal-only" },
        { value: "preregistered", label: "Pre-registered" },
        { value: "unknown", label: "Unknown" },
      ],
    },
    {
      kind: "voting-history-count",
      key: "voting_history",
      label: "Voting History",
      source: "column",
    },
  ],
] as const;

export const FILTERS: ReadonlyArray<FilterDef> = FILTER_SECTIONS.flatMap((s) => s);

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
  if (def.kind === "text") return { kind: "text", key: def.key, value: "" };
  if (def.kind === "date-range") return { kind: "date-range", key: def.key, min: null, max: null };
  if (def.kind === "address")
    return { kind: "address", key: "address", line1: "", city: "", state: "", zip: "" };
  // Voting history default: "voted in 1+ recent primaries" (single prime).
  return {
    kind: "voting-history-count",
    key: def.key,
    type: "primary",
    windowYears: 4,
    comparator: "at_least",
    count: 1,
  };
}

// True if a filter materially constrains (or expands) the result set.
export function isActiveFilter(f: Filter): boolean {
  if (f.kind === "all") return true;
  if (f.kind === "enum") return f.values.length > 0;
  if (f.kind === "text") return f.value.trim().length > 0;
  if (f.kind === "age-range") return f.min != null || f.max != null;
  if (f.kind === "date-range") return f.min != null || f.max != null;
  if (f.kind === "address")
    return (
      f.line1.trim().length > 0 ||
      f.city.trim().length > 0 ||
      f.state.trim().length > 0 ||
      f.zip.trim().length > 0
    );
  // voting-history-count: active when window and count are non-degenerate.
  return f.windowYears > 0 && f.count >= 0;
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
