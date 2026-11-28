"""Votes → each person's `voting_history` list, for importers whose history
arrives as one row per vote.

The importer reduces its raw history to counted votes (`voter_id`,
`election_date`, canonical `type` and `method`); `one_vote_per_election_sql`
keeps one per voter per election and `group_votes` gathers each voter's into the
canonical `voting_history` list.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import duckdb

VOTING_HISTORY_TYPE = "STRUCT(year INT, type VARCHAR, date VARCHAR, method VARCHAR)[]"

# Every importer's election types. `primary_runoff` and `general_runoff` are the
# second rounds of a primary and a general; `other` is an election the source
# names but doesn't classify (local and municipal elections, unmapped labels).
ELECTION_TYPES = (
    "general",
    "general_runoff",
    "primary",
    "primary_runoff",
    "presidential_primary",
    "special",
    "other",
)

# When a voter has several counted votes for one election, the first method here wins.
METHOD_PRIORITY = ("poll_site", "early_voting", "absentee", "other")

# Votes grouped into lists per pass. Florida statewide (about 69M votes) groups
# in 14 passes within a 10GB memory limit; a county-sized import in one.
VOTES_PER_BATCH = 5_000_000


def one_vote_per_election_sql(votes_sql: str) -> str:
    """SQL keeping one vote per voter per election from `votes_sql`, a query
    yielding `voter_id`, `election_date` (DATE), `type`, and `method`. Rows
    missing any of the first three are dropped."""
    rank = " ".join(f"WHEN '{method}' THEN {i}" for i, method in enumerate(METHOD_PRIORITY))
    return f"""
SELECT voter_id, election_date, type, arg_min(method, rank) AS method
FROM (SELECT *, CASE method {rank} END AS rank FROM ({votes_sql}))
WHERE voter_id IS NOT NULL AND election_date IS NOT NULL AND type IS NOT NULL
GROUP BY voter_id, election_date, type
"""


def _batch_sql(votes_table: str, batches: int, batch: int) -> str:
    """SQL grouping batch `batch` of `batches` (a hash-partition of voters) into
    one `voting_history` list per voter."""
    return f"""
SELECT
    voter_id,
    -- `list_sort` orders by the first field, the date, so entries run
    -- chronologically; `list()` with an ORDER BY would need every input in
    -- memory before it could finish.
    list_transform(
        list_sort(list({{
            'date': strftime(election_date, '%Y-%m-%d'),
            'type': type,
            'method': method
        }})),
        e -> {{'year': CAST(left(e.date, 4) AS INT), 'type': e.type, 'date': e.date, 'method': e.method}}
    )::{VOTING_HISTORY_TYPE} AS voting_history
FROM {votes_table}
WHERE hash(voter_id) % {batches} = {batch}
GROUP BY voter_id
"""


def group_votes(votes_table: str, grouped_table: str, conn: duckdb.DuckDBPyConnection) -> None:
    """`votes_table` (one vote per voter per election) → `grouped_table`, one
    `voting_history` per voter. DuckDB can't spill `list()` state to disk, so
    voters are grouped `VOTES_PER_BATCH` votes at a time."""
    conn.execute(f"CREATE OR REPLACE TABLE {grouped_table} (voter_id VARCHAR, voting_history {VOTING_HISTORY_TYPE})")
    votes = conn.execute(f"SELECT count(*) FROM {votes_table}").fetchone()[0]
    batches = max(1, math.ceil(votes / VOTES_PER_BATCH))
    for batch in range(batches):
        conn.execute(f"INSERT INTO {grouped_table} {_batch_sql(votes_table, batches, batch)}")
