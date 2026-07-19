"""Shared election-identity helpers for the voting-history filters.

An election is identified by (year, type) — no month. Per-record months in the
raw voter history are unreliable (corrupt date bytes; older records are date-less
in the source) and bought only brittleness: generals are one-per-year regardless,
and primaries/specials collapse cleanly to a year+type bucket. Keying by
(year, type) sidesteps all of it — a corrupt month still lands in the right
year+type, and dated/undated records of the same election merge automatically.

`election_key_sql` is the single place the key formula lives, so the detail
filter's compiled predicate and the picker's precomputed options can't drift.
"""

from __future__ import annotations

# Minimum distinct voters for a (year, type) to be offered as an election. Real
# elections draw thousands+; corrupt or degenerate keys draw a handful — a raw
# floor (not a share, which would silently re-cut as the data changes) cleanly
# separates them. Kept low so it generalizes beyond NYC-scale datasets.
ELECTION_MIN_VOTERS = 100

_TYPE_LABELS = {
    "general": "General",
    "primary": "Primary",
    "presidential_primary": "Presidential Primary",
    "special": "Special",
    "runoff": "Runoff",
}


def election_key_sql(entry: str) -> str:
    """DuckDB expression mapping a voting_history STRUCT entry (bound as `entry`)
    to its `<year>-<type>` key, e.g. `2024-general`. Used by the detail filter's
    compile clause and the picker precompute so the two can't drift."""
    return f"{entry}.year || '-' || {entry}.type"


def election_label(year: int, type_: str) -> str:
    """Human label for an election, e.g. "2024 General" or "2022 Primary"."""
    return f"{year} {_TYPE_LABELS.get(type_, type_.replace('_', ' ').title())}"
