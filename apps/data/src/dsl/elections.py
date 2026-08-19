"""Shared election-identity helpers for the voting-history filters.

An election is identified by (year, type) — no month. Per-record months in the
raw voter history are unreliable (corrupt date bytes; older records are date-less
in the source) and bought only brittleness: generals are one-per-year regardless,
and primaries/specials collapse cleanly to a year+type bucket. Keying by
(year, type) sidesteps all of it — a corrupt month still lands in the right
year+type, and dated/undated records of the same election merge automatically.

`election_key_sql` is the single place the key formula lives, so the detail
filter's compiled predicate and the picker's precomputed options can't drift.

Each dataset version also carries a *registry*: every above-floor election is
assigned a bit index (newest first), and per-voter participation is materialized
at import as fixed-width mask columns (`voting_history_mask_0`, `_1`, …; 64
elections per word). Both voting-history filters compile to bitwise tests on
those columns instead of scanning the STRUCT[] — the nested column stays the
source of truth for display/export. Bit indices are a per-version contract:
they live in the version's `elections` lake table and `derived_metadata`, and
are never shared or reordered across versions (each import reassigns from
scratch). Newest-first assignment keeps typical (recent-election) selections
inside word 0, so queries usually read a single mask column.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import duckdb

# Minimum distinct voters for a (year, type) to be offered as an election. Real
# elections draw thousands+; corrupt or degenerate keys draw a handful — a raw
# floor (not a share, which would silently re-cut as the data changes) cleanly
# separates them. Kept low so it generalizes beyond NYC-scale datasets.
ELECTION_MIN_VOTERS = 100

# Canonical name of the voting-history STRUCT[] column and its mask companions.
# Assembly detects the column by this name; the compiler derives mask column
# names from the manifest field's `column`, so the two agree as long as
# manifests bind voting-history fields to this column (all importers do).
VOTING_HISTORY_COLUMN = "voting_history"

# Per-version lake table recording the registry (key, year, type, bit,
# voter_count). Written by assembly, read back by derived-metadata computation.
ELECTIONS_TABLE = "elections"

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


def election_year(key: str) -> int:
    """The year component of an election key (`2024-general` → 2024)."""
    return int(key.split("-", 1)[0])


def election_type(key: str) -> str:
    """The type component of an election key (`2024-general` → `general`)."""
    return key.split("-", 1)[1]


def mask_words(election_count: int) -> int:
    """Number of UBIGINT mask columns needed for `election_count` bits."""
    return (election_count + 63) // 64


def mask_column(column: str, word: int) -> str:
    """Mask column name for word `word` of a voting-history `column`."""
    return f"{column}_mask_{word}"


def compute_election_registry(
    conn: duckdb.DuckDBPyConnection, src_fqn: str, column: str = VOTING_HISTORY_COLUMN
) -> list[tuple[str, int, str]]:
    """The version's election registry: above-floor (year, type) elections as
    (key, year, type) tuples, newest first. A key's position in this list is its
    bit index — the ordering is the bit assignment, so it must stay
    deterministic (year desc, then type)."""
    rows = conn.execute(
        f"""
        SELECT {election_key_sql("e")} AS key, e.year AS year, e.type AS type
        FROM {src_fqn}, UNNEST({column}) AS t(e)
        WHERE e.year IS NOT NULL
        GROUP BY 1, 2, 3
        HAVING count(DISTINCT external_id) >= ?
        """,
        [ELECTION_MIN_VOTERS],
    ).fetchall()
    rows.sort(key=lambda r: (-r[1], r[2]))
    return rows


def mask_select_exprs(keys: list[str], column: str = VOTING_HISTORY_COLUMN) -> list[str]:
    """SELECT expressions materializing the mask columns from a voting-history
    STRUCT[] column, one per word. `keys` is the registry in bit order. OR-fold
    rather than sum: duplicate history entries for one election must set its
    bit once, never carry into a neighbor."""
    exprs: list[str] = []
    for word in range(mask_words(len(keys))):
        cases = " ".join(
            f"WHEN '{key.replace("'", "''")}' THEN {1 << (bit - 64 * word)}::UBIGINT"
            for bit, key in enumerate(keys)
            if bit // 64 == word
        )
        exprs.append(
            f"coalesce(list_reduce(list_prepend(0::UBIGINT, "
            f"list_transform({column}, e -> CASE {election_key_sql('e')} {cases} ELSE 0::UBIGINT END)), "
            f"(a, b) -> a | b), 0::UBIGINT) AS {mask_column(column, word)}"
        )
    return exprs


def word_masks(bits: dict[str, int], keys: list[str]) -> list[int]:
    """Fold selected election `keys` into one literal mask per word, sized by
    the highest selected bit (untouched trailing words contribute no predicate
    terms anyway). Keys not in `bits` are the caller's concern (they mean
    "not in this version")."""
    masks = [0] * mask_words(1 + max(bits[key] for key in keys))
    for key in keys:
        bit = bits[key]
        masks[bit // 64] |= 1 << (bit % 64)
    return masks


def election_bits(derived_metadata: dict | None) -> dict[str, int] | None:
    """The key→bit registry from a version's derived-metadata blob — what the
    voting-history clauses compile selected elections through. None when the
    version carries no registry (no voting history, or imported pre-masks)."""
    elections = (derived_metadata or {}).get("elections")
    if elections is None or any("bit" not in e for e in elections):
        return None
    return {e["value"]: e["bit"] for e in elections}
