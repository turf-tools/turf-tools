"""Unit tests for the election registry and mask helpers in src/dsl/elections.py,
against a plain in-memory DuckDB."""

import pytest

import duckdb
from src.dsl.elections import ELECTION_MIN_VOTERS, compute_election_registry, mask_select_exprs

HISTORY = "STRUCT(year INT, type VARCHAR, date VARCHAR, method VARCHAR)[]"


@pytest.fixture()
def conn():
    c = duckdb.connect()
    yield c
    c.close()


def _entry(year: int, type_: str = "general") -> dict:
    return {"year": year, "type": type_, "date": None, "method": None}


def test_masks_are_ubigint_with_exact_high_bits(conn):
    """Bit 63 (the last of word 0) and bit 64 (the first of word 1) land exactly,
    and the columns are UBIGINT: the lake can't store a wider integer exactly."""
    keys = [f"{2100 - i}-general" for i in range(70)]
    history = [_entry(2100 - 63), _entry(2100 - 64), _entry(2100 - 64), _entry(1900)]
    exprs = mask_select_exprs(keys)
    row = conn.execute(
        f"SELECT {', '.join(exprs)}, {', '.join(f'typeof({e.rsplit(" AS ", 1)[0]})' for e in exprs)} "
        f"FROM (SELECT ?::{HISTORY} AS voting_history)",
        [history],
    ).fetchone()
    assert row[:2] == (1 << 63, 1)
    assert row[2:] == ("UBIGINT", "UBIGINT")


def test_registry_counts_each_voter_once(conn):
    """A voter's repeated entries for one election count once toward the floor."""
    conn.execute(f"CREATE TABLE p (external_id VARCHAR, voting_history {HISTORY})")
    rows = [(f"v{i}", [_entry(2024)]) for i in range(ELECTION_MIN_VOTERS - 1)]
    rows.append(("dup", [_entry(2022), _entry(2022)]))
    rows += [(f"w{i}", [_entry(2022)]) for i in range(ELECTION_MIN_VOTERS - 2)]
    rows.append(("last", [_entry(2024)]))
    conn.executemany("INSERT INTO p VALUES (?, ?)", rows)
    registry = compute_election_registry(conn, "p")
    assert registry == [("2024-general", 2024, "general")]
