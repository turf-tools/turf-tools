// The segment-criteria DSL: filter instance types, the `FilterDef` editor
// metadata, and helpers. The dataset field catalog is built from the manifest
// (see `lib/manifest.ts`); only the dataset-independent system filters are
// hardcoded here. The data server compiles criteria → SQL.
import { BLUE, GREEN, RED } from "~/lib/palette";

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

// Multi-value text filter — matches if the column equals any of `values`
// (OR'd into SQL `IN (...)`). Used for short-code district fields where
// users typically know multiple specific values they want to include.
// Single-value remains expressible as a one-element array.
export type TextMultiFilter = {
  kind: "text-multi";
  key: string;
  values: string[];
};

export type DateRangeFilter = {
  kind: "date-range";
  key: string;
  min: string | null; // ISO 8601 YYYY-MM-DD
  max: string | null;
};

export type VotingHistoryCountFilter = {
  kind: "voting-history-count";
  key: string;
  type: "primary" | "general";
  windowYears: number;
  comparator: "at_least" | "exactly";
  count: number;
};

// Membership in specific named elections. `mode` picks the set semantics: "any"
// matches a person who voted in at least one selected election, "all" requires
// every one. Each value is an election's stable key (e.g. `2024-06-primary`);
// the option set is precomputed per version (see `queries/elections`).
export type VotingHistoryDetailFilter = {
  kind: "voting-history-detail";
  key: string;
  mode: "any" | "all";
  elections: string[];
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

// Numeric range over a number-type custom field. Either bound optional.
export type NumberRangeFilter = {
  kind: "number-range";
  key: string;
  min: number | null;
  max: number | null;
};

// Canvass-outcome filter — reads prior canvass dispositions back out of
// canvass_events; it is NOT a person-row column. Matches a person if any
// of their per-turf current results has an outcome in `outcomes`.
// Resolved server-side to a person-id set before SQL compilation (see
// apps/data/src/dsl/resolve.py), the same way SegmentFilter is.
export type CanvassOutcomeFilter = {
  kind: "canvass-outcome";
  key: "canvass_outcome";
  outcomes: string[];
};

// Canvass-response filter — matches a person if any of their per-turf current
// results answered `questionId` with one of `optionIds`. Like
// CanvassOutcomeFilter it reads canvass_events and is resolved server-side to a
// person-id set (see apps/data/src/dsl/resolve.py). Select-type questions
// only; the option set is fetched live by the editor, so the catalog entry
// carries no static values.
export type CanvassResponseFilter = {
  kind: "canvass-response";
  key: "canvass_response";
  questionId: string | null;
  optionIds: string[];
};

// Reference to another segment by id. Authored form — what the user
// composes and what we persist. Resolved to NestedFilter (below) on the
// data server (see `apps/data/src/dsl/expand.py`).
export type SegmentFilter = {
  kind: "segment";
  key: "segment";
  segmentId: string | null;
};

// Result of expanding a SegmentFilter: carries the referenced
// segment's full criteria inline. The data server compiles this as a
// parenthesized boolean expression (see apps/data/src/dsl/compile.py).
// Never persisted — only on the wire.
export type NestedFilter = {
  kind: "nested";
  criteria: Criteria;
};

export type Filter =
  | AllFilter
  | EnumFilter
  | AgeRangeFilter
  | TextFilter
  | TextMultiFilter
  | DateRangeFilter
  | VotingHistoryCountFilter
  | VotingHistoryDetailFilter
  | AddressFilter
  | NumberRangeFilter
  | CanvassOutcomeFilter
  | CanvassResponseFilter
  | SegmentFilter
  | NestedFilter;

// Criteria — ordered sequence of steps with verbs.
export type Verb = "add" | "narrow" | "remove";
export type Step = { id: string; verb: Verb; filter: Filter };
export type Criteria = { steps: Step[] };

// A filterable field's editor metadata. The dataset-field defs are built from
// the manifest (see `lib/manifest.ts`); the system defs below are hardcoded.
// `op` on text filters is fixed per-field: names use substring `contains`,
// codes/zips use `equals`.
export type FilterDef =
  | { kind: "all"; key: "all"; label: string }
  | {
      kind: "enum";
      key: string;
      label: string;
      values: ReadonlyArray<{ value: string; label?: string }>;
    }
  | { kind: "age-range"; key: string; label: string }
  | { kind: "text"; key: string; label: string }
  | { kind: "text-multi"; key: string; label: string }
  | { kind: "date-range"; key: string; label: string }
  | { kind: "voting-history-count"; key: string; label: string }
  | { kind: "voting-history-detail"; key: string; label: string }
  | { kind: "address"; key: "address"; label: string }
  | { kind: "number-range"; key: string; label: string }
  | {
      kind: "canvass-outcome";
      key: "canvass_outcome";
      label: string;
      values: ReadonlyArray<{ value: string; label?: string }>;
    }
  | { kind: "canvass-response"; key: "canvass_response"; label: string }
  | { kind: "segment"; key: "segment"; label: string };

// System filters are dataset-independent — they match everyone, read
// canvass_events, or reference another segment, so they live outside the
// manifest. The web frames the manifest's field sections with these: `all` on
// top, canvass + segment at the bottom (see `buildFilterCatalog`).
export const SYSTEM_TOP_SECTION: ReadonlyArray<FilterDef> = [
  { kind: "all", key: "all", label: "Everyone" },
];

export const SYSTEM_BOTTOM_SECTIONS: ReadonlyArray<ReadonlyArray<FilterDef>> = [
  // Canvass history — prior results read back from canvass_events. Only
  // person-level outcomes are exposed (door/building dispositions like
  // address_not_found / inaccessible aren't person results).
  [
    {
      kind: "canvass-outcome",
      key: "canvass_outcome",
      label: "Canvass Outcome",
      values: [
        { value: "canvassed", label: "Canvassed" },
        { value: "not_home", label: "Not home" },
        { value: "deceased", label: "Deceased" },
        { value: "hostile", label: "Hostile" },
        { value: "moved", label: "Moved" },
      ],
    },
    { kind: "canvass-response", key: "canvass_response", label: "Canvass Response" },
  ],
  // Composite — reference another segment by id.
  [{ kind: "segment", key: "segment", label: "Segment" }],
];

// Helpers
export function filterKey(f: Filter): string {
  if (f.kind === "all") return "all";
  if (f.kind === "nested") return "nested";
  return f.key;
}

export function emptyFilterFor(def: FilterDef): Filter {
  if (def.kind === "all") return { kind: "all" };
  if (def.kind === "enum") return { kind: "enum", key: def.key, values: [] };
  if (def.kind === "age-range") return { kind: "age-range", key: def.key, min: null, max: null };
  if (def.kind === "text") return { kind: "text", key: def.key, value: "" };
  if (def.kind === "text-multi") return { kind: "text-multi", key: def.key, values: [] };
  if (def.kind === "date-range") return { kind: "date-range", key: def.key, min: null, max: null };
  if (def.kind === "address")
    return { kind: "address", key: "address", line1: "", city: "", state: "", zip: "" };
  if (def.kind === "number-range")
    return { kind: "number-range", key: def.key, min: null, max: null };
  if (def.kind === "canvass-outcome")
    return { kind: "canvass-outcome", key: "canvass_outcome", outcomes: [] };
  if (def.kind === "canvass-response")
    return { kind: "canvass-response", key: "canvass_response", questionId: null, optionIds: [] };
  if (def.kind === "segment") return { kind: "segment", key: "segment", segmentId: null };
  if (def.kind === "voting-history-detail")
    return { kind: "voting-history-detail", key: def.key, mode: "any", elections: [] };
  // Voting history count default: "voted in 1+ recent primaries" (single prime).
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
  if (f.kind === "text-multi") return f.values.length > 0;
  if (f.kind === "age-range") return f.min != null || f.max != null;
  if (f.kind === "date-range") return f.min != null || f.max != null;
  if (f.kind === "address")
    return (
      f.line1.trim().length > 0 ||
      f.city.trim().length > 0 ||
      f.state.trim().length > 0 ||
      f.zip.trim().length > 0
    );
  if (f.kind === "number-range") return f.min != null || f.max != null;
  if (f.kind === "canvass-outcome") return f.outcomes.length > 0;
  if (f.kind === "canvass-response") return f.questionId != null && f.optionIds.length > 0;
  if (f.kind === "segment") return f.segmentId != null;
  if (f.kind === "nested") return f.criteria.steps.length > 0;
  if (f.kind === "voting-history-detail") return f.elections.length > 0;
  // voting-history-count: active when window and count are non-degenerate.
  return f.windowYears > 0 && f.count >= 0;
}

export function isActiveStep(s: Step): boolean {
  return isActiveFilter(s.filter);
}

// True if the criteria reads a *live*, continuously-drifting source (today, the
// canvass leaves). Such queries can't use `staleTime: Infinity` — the answer
// drifts as canvassing happens. A versioned source (e.g. a future tag upload) is
// different: bake a version into the query key instead, the way boundaries key
// on `updatedAt`.
export function criteriaTouchesLiveData(
  criteria: Criteria,
  segmentsById?: ReadonlyMap<string, { criteria: unknown }>,
  visited: Set<string> = new Set(),
): boolean {
  // Tolerate a steps-less object — callers (e.g. campaignKeyCountsQuery) pass a
  // `{} as SegmentCriteria` placeholder while the query is disabled.
  return (criteria.steps ?? []).some((step) => {
    const f = step.filter;
    if (f.kind === "canvass-outcome" || f.kind === "canvass-response") return true;
    if (f.kind === "nested") return criteriaTouchesLiveData(f.criteria, segmentsById, visited);
    // Follow segment refs when the caller supplies the lookup — a ref to a
    // segment built on canvass leaves reads the same drifting source.
    if (f.kind === "segment" && f.segmentId != null && segmentsById && !visited.has(f.segmentId)) {
      visited.add(f.segmentId);
      const ref = segmentsById.get(f.segmentId);
      return ref ? criteriaTouchesLiveData(ref.criteria as Criteria, segmentsById, visited) : false;
    }
    return false;
  });
}

// Verb display metadata — label and accent color.
export const VERB_META: Record<Verb, { label: string; color: string }> = {
  narrow: { label: "Narrow", color: BLUE },
  add: { label: "Add", color: GREEN },
  remove: { label: "Remove", color: RED },
};
