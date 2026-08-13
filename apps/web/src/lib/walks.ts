// How long a walk can plausibly still be the same outing. Shared by the
// board's live display and walks.open's rescan dedup — the two must
// agree, or a rescan of a decayed-but-open walk dedupes into a row the
// board no longer shows as live, and the pending spinner never clears.
export const WALK_LIVE_MS = 5 * 60 * 60_000;
