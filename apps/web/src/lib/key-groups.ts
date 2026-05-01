// Per-key-group configuration for cross-referencing persons with
// boundary regions. A zone group's `keyGroup` ("nyc_eds", "nyc_zips",
// ...) names a boundary table; this module says what field on
// `{org}_persons_geocoded` carries each person's region key. Per-zone
// aggregation joins on that field's value directly — boundaries are
// derived from the voter file (apps/data/src/dags/boundaries.py), so
// the boundary key is the voter-file value verbatim, no translation
// required.

import { columnExprFor } from "./criteria-to-sql";

type KeyGroupConfig = {
  // Persons-table field (a catalog entry in FILTERS).
  fieldKey: string;
};

const CONFIG: Record<string, KeyGroupConfig> = {
  nyc_eds: { fieldKey: "ad_ed" },
  nyc_zips: { fieldKey: "zip5" },
};

// Hardcoded list of key groups admins can pick from in the UI
// (zones editor, New Campaign "construct from key" path). Labels
// stay generic — boundaries are derived from the voter file, so
// the same key group works in any state once the file is loaded.
// Will become a registry endpoint when we support per-org key
// groups beyond these two.
export const KEY_GROUPS_AVAILABLE: ReadonlyArray<{ value: string; label: string }> = [
  { value: "nyc_eds", label: "Election districts" },
  { value: "nyc_zips", label: "ZIP codes" },
];

// SQL expression producing each person's boundary-key for the given
// keyGroup. Used as the GROUP BY target in per-zone aggregation.
export function boundaryKeyExprFor(keyGroup: string): string {
  const config = CONFIG[keyGroup];
  if (!config) throw new Error(`Unknown keyGroup: ${keyGroup}`);
  return columnExprFor(config.fieldKey);
}
