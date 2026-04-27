// Per-key-group configuration for cross-referencing persons with
// boundary regions. A zone group's `keyGroup` ("nyc_eds", "nyc_zips",
// ...) names a boundary table; this module says what field on
// `{org}_persons_geocoded` carries each person's region key, and how
// to translate that field's value into the format the boundary table
// uses for its `key` column. Per-zone aggregation joins on the
// transformed value, so any storage-format mismatch (NYC EDs are
// stored as "23-001" on persons but "23001" on boundaries) gets
// healed once, here, instead of leaking into every consumer.

import { columnExprFor } from "./query-to-sql";

type KeyGroupConfig = {
  // Persons-table field (a catalog entry in FILTERS).
  fieldKey: string;
  // Optional SQL transform from the field's stored value to the
  // boundary-key format. Receives the resolved column expression
  // (already wrapped by columnExprFor for JSONB extracts) and returns
  // an expression that yields the boundary-key string.
  toBoundaryKey?: (expr: string) => string;
};

const CONFIG: Record<string, KeyGroupConfig> = {
  nyc_eds: {
    fieldKey: "ad_ed",
    // Persons store the composite key with a hyphen ("23-001");
    // boundary features identify their region as "23001". Strip the
    // hyphen so the GROUP BY result keys match the GeoJSON keys.
    toBoundaryKey: (expr) => `replace(${expr}, '-', '')`,
  },
  nyc_zips: {
    // ZIP5 and MODZCTA agree for most NYC ZIPs but diverge in the
    // handful of cases where USPS split or added a ZIP after the
    // 2010 Census MODZCTA was frozen — e.g. 11249 (carved out of
    // 11211 in 2011) has no MODZCTA polygon and never matches.
    //
    // TODO: swap this dataset for OpenDataDE/State-zip-code-GeoJSON
    // (TIGER-derived ZCTA5, native zip5 keys, includes 11249) and
    // drop the `nyc_zips` MODZCTA boundary. See the chat on
    // 2026-04-27 for the migration recipe — drop the geojson into
    // apps/data/fixtures, add a `nyc_zcta` entry to seed_boundaries,
    // map `nyc_zcta: { fieldKey: "zip5" }` here, retire `nyc_zips`.
    fieldKey: "zip5",
  },
};

// SQL expression producing each person's boundary-key for the given
// keyGroup. Used as the GROUP BY target in per-zone aggregation.
export function boundaryKeyExprFor(keyGroup: string): string {
  const config = CONFIG[keyGroup];
  if (!config) throw new Error(`Unknown keyGroup: ${keyGroup}`);
  const expr = columnExprFor(config.fieldKey);
  return config.toBoundaryKey ? config.toBoundaryKey(expr) : expr;
}
