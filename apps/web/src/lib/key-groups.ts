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
