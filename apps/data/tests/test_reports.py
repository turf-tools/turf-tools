"""The report specs (src.reports) rendered end-to-end: real composed
SQL against the synthetic operational catalog, driven through the same
preview/export helpers the /reports/* routes use.
"""

from __future__ import annotations

import os
import tempfile
from contextlib import suppress

import pytest

from src.models import EXPORT_COLUMNS
from src.reports import SPECS, build_ctx, export_copy, preview
from tests.test_canvass_events import (
    APP,
    DAY1_NOON,
    DAY2_NOON,
    TZ,
    _seed,
    _seed_attempt_extras,
)


def _seed_reports(conn) -> None:
    """Walks, question/option labels, and a full-column persons table for
    the voter-file join. Population = the base story's people (p6 stays
    out, preserving the not-in-population case)."""
    conn.execute(
        f"""CREATE TABLE {APP}.walks (
            walk_id VARCHAR, turf_id VARCHAR, canvasser_name VARCHAR,
            canvasser_phone VARCHAR, opened_at TIMESTAMPTZ, closed_at TIMESTAMPTZ)"""
    )
    conn.executemany(
        f"INSERT INTO {APP}.walks VALUES (?, ?, ?, ?, ?::TIMESTAMPTZ, NULL)",
        [
            ("w1", "turf1", "Jer", "+1", DAY1_NOON),
            ("wA", "turf1", "Jer", "+1", DAY1_NOON),
            ("wB", "turf1", "Os", "+2", DAY1_NOON),
            ("w2", "turf2", "Os", "+2", DAY2_NOON),
            ("w3", "turf1", "Os", "+2", DAY2_NOON),
            ("w9", "turf3", "Os", "+2", DAY2_NOON),
        ],
    )
    conn.execute(
        f"""CREATE TABLE {APP}.questions (
            question_id VARCHAR, organization_id VARCHAR, name VARCHAR,
            created_at TIMESTAMPTZ)"""
    )
    conn.executemany(
        f"INSERT INTO {APP}.questions VALUES (?, 'org1', ?, ?::TIMESTAMPTZ)",
        [
            ("q1", "Support", "2026-08-01 00:00:00+00"),
            ("q2", "Issues", "2026-08-02 00:00:00+00"),
            ("qt", "Notes", "2026-08-03 00:00:00+00"),
        ],
    )
    conn.execute(
        f"""CREATE TABLE {APP}.response_options (
            response_option_id VARCHAR, question_id VARCHAR, text VARCHAR, "order" INT)"""
    )
    conn.executemany(
        f"INSERT INTO {APP}.response_options VALUES (?, ?, ?, ?)",
        [
            ("yes", "q1", "Yes", 1),
            ("no", "q1", "No", 2),
            ("a", "q2", "A", 1),
            ("b", "q2", "B", 2),
        ],
    )
    cols = ", ".join(f"{c} VARCHAR" for c in EXPORT_COLUMNS)
    conn.execute(f"CREATE TABLE persons_full ({cols})")
    fill = ", ".join("?" for _ in EXPORT_COLUMNS)
    for pid in ["p1", "p2", "p3", "p4", "p5", "p7", "p8"]:
        row = {c: None for c in EXPORT_COLUMNS}
        row["external_id"] = pid
        row["last_name"] = f"Voter {pid}"
        conn.execute(
            f"INSERT INTO persons_full VALUES ({fill})",
            [row[c] for c in EXPORT_COLUMNS],
        )


@pytest.fixture()
def conn(operational_conn):
    _seed(operational_conn)
    _seed_attempt_extras(operational_conn)
    _seed_reports(operational_conn)
    return operational_conn


def _preview(conn, kind: str, day: str | None = None, sort: str | None = None, dir_: str = "asc"):
    ctx = build_ctx(conn, "persons_full", "testorg", ["camp1"], day, TZ)
    return preview(conn, kind, SPECS[kind](conn, ctx), 0, sort, dir_)


def _by_col(result: dict) -> list[dict]:
    return [dict(zip(result["columns"], row, strict=True)) for row in result["rows"]]


def test_people_rows_are_current_state(conn) -> None:
    result = _preview(conn, "people")
    # p3 clear-erased, p6 not in the population; everyone else attempted.
    assert result["total"] == 6
    assert result["questionColumns"] == ["Support", "Issues", "Notes"]
    rows = {r["external_id"]: r for r in _by_col(result)}
    # p2's current snapshot: option labels joined, multi-select joined.
    assert rows["p2"]["last_outcome"] == "canvassed"
    assert rows["p2"]["Support"] == "No"
    assert rows["p2"]["Issues"] == "A; B"
    assert rows["p2"]["Notes"] == "Julian"
    # No turf/zone on people; campaign labels the winning pass.
    assert "turf" not in rows["p2"] and rows["p2"]["campaign"] == "Camp One"
    # p1's current snapshot is the not_home — the earlier answer is gone.
    assert rows["p1"]["last_outcome"] == "not_home"
    assert rows["p1"]["Support"] is None
    assert (rows["p1"]["attempts"], rows["p1"]["contacts"]) == (1, 0)
    assert (rows["p8"]["attempts"], rows["p8"]["contacts"]) == (2, 1)
    assert result["summary"] == {"outcomes": {"canvassed": 4, "not_home": 2}}


def test_attempts_rows_pivot_their_own_snapshot(conn) -> None:
    result = _preview(conn, "attempts")
    assert result["total"] == 8
    assert result["summary"]["people"] == 6
    assert result["summary"]["outcomes"] == {"canvassed": 4, "not_home": 4}
    p7 = [r for r in _by_col(result) if r["external_id"] == "p7"]
    assert {(r["outcome"], r["Support"], r["walk_id"]) for r in p7} == {
        ("not_home", None, "wA"),
        ("canvassed", "Yes", "wB"),
    }


def test_responses_rows_are_per_canvassed_attempt(conn) -> None:
    result = _preview(conn, "responses")
    assert result["total"] == 5
    assert {(r["question"], r["answer"], r["question_id"], r["option_id"]) for r in _by_col(result)} == {
        ("Support", "No", "q1", "no"),
        ("Issues", "A", "q2", "a"),
        ("Issues", "B", "q2", "b"),
        ("Notes", "Julian", "qt", None),
        ("Support", "Yes", "q1", "yes"),
    }
    assert result["summary"] == {
        "people": 2,
        "questions": [
            {"label": "Support", "count": 2},
            {"label": "Issues", "count": 2},
            {"label": "Notes", "count": 1},
        ],
    }


def test_walks_rows_hide_inactive_and_scope(conn) -> None:
    result = _preview(conn, "walks")
    rows = _by_col(result)
    # w9 is camp2; w3 (the clear's walk) is hidden — erased history
    # can't reach the tallies, and activity-less sign-outs don't row.
    assert result["total"] == 4
    stats = {(r["turf_code"], r["canvasser"]): (r["attempts"], r["contacts"]) for r in rows}
    assert stats[("T2", "Os")] == (1, 0)
    assert sum(r["attempts"] for r in rows) == 6
    assert all(r["walk_id"] for r in rows)
    assert result["summary"] == {"canvassers": 2, "turfs": 2, "attempts": 6, "contacts": 3}


def test_canvassers_rows_group_attestation(conn) -> None:
    result = _preview(conn, "canvassers")
    rows = {r["phone"]: r for r in _by_col(result)}
    assert (rows["+1"]["walks"], rows["+1"]["attempts"], rows["+1"]["contacts"]) == (2, 6, 3)
    assert (rows["+2"]["walks"], rows["+2"]["attempts"], rows["+2"]["contacts"]) == (2, 2, 1)
    assert result["summary"] == {"canvassers": 2, "walks": 4, "attempts": 8, "contacts": 4}


def test_sort_and_day_scope(conn) -> None:
    result = _preview(conn, "people", sort="attempts", dir_="desc")
    attempts = [r["attempts"] for r in _by_col(result)]
    assert attempts == sorted(attempts, reverse=True)
    day1 = _preview(conn, "attempts", day="2026-08-23")
    # Day 1: p1, p2, p5, p7 x2, p8 — not p4 (day 2). Not p3 either: its
    # day-2 clear erases absolutely — a clear edits the turf's shared
    # record, so a mistaken attempt stays erased in historical day views
    # rather than resurrecting when the window predates the clear.
    assert day1["total"] == 6
    assert day1["days"] == ["2026-08-24", "2026-08-23"]


def test_export_copies_the_full_table(conn) -> None:
    ctx = build_ctx(conn, "persons_full", "testorg", ["camp1"], None, TZ)
    spec = SPECS["responses"](conn, ctx)
    fd, tmp_path = tempfile.mkstemp(suffix=".csv")
    os.close(fd)
    try:
        assert export_copy(conn, spec, None, "asc", tmp_path, "csv") == 5
        with open(tmp_path) as f:
            assert len(f.read().strip().splitlines()) == 6  # header + 5 answers
    finally:
        with suppress(OSError):
            os.remove(tmp_path)
