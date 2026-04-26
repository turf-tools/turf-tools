// Curated list of Person `other_properties` fields exposed as filter
// primitives in the segment editor. Each entry tells the leaf-filter UI
// how to render itself — `kind` drives the input component (multi-select,
// number range, etc.) and `values` (for enum) provides the choices.
//
// Kept independent from the native app's render-side list because the two
// have different shapes and different curation needs (filterable ≠
// display-worthy). See `docs/product-model.md`.

export type OtherPropertyDefinition =
  | {
      key: string;
      label: string;
      kind: "enum";
      values: ReadonlyArray<{ value: string; label?: string }>;
    }
  | {
      key: string;
      label: string;
      kind: "age-range";
    };

export const OTHER_PROPERTY_KEYS: ReadonlyArray<OtherPropertyDefinition> = [
  {
    key: "party",
    label: "Party",
    kind: "enum",
    // NYS BOE enrollment codes. Full list exists; these are the common
    // values most segments will want to filter on.
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
    key: "gender",
    label: "Gender",
    kind: "enum",
    values: [
      { value: "M", label: "Male" },
      { value: "F", label: "Female" },
      { value: "U", label: "Unknown" },
    ],
  },
  {
    key: "date_of_birth",
    label: "Age",
    kind: "age-range",
  },
] as const;
