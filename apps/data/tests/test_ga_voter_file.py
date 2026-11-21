"""Georgia-specific importer behaviour beyond the shared contract tests."""

from __future__ import annotations

from pathlib import Path

from src.importers.base import ImportFilter
from src.importers.ga_voter_file import GaVoterFileImporter
from src.importers.ga_voter_file.sample_data.make_sample import voter_registration_number
from src.tables import table_fqn

SCHEMA = "ga_v1"
SAMPLE_DATA = Path(__file__).parent.parent / "src/importers/ga_voter_file/sample_data"
SOURCES = {"file": str(SAMPLE_DATA / "file.csv"), "history": str(SAMPLE_DATA / "history.csv")}


class _Progress:
    def __init__(self) -> None:
        self.steps = 0

    def advance(self, n: int = 1) -> None:
        self.steps += n


def _load(conn, sources=SOURCES, filter: ImportFilter | None = None) -> _Progress:
    progress = _Progress()
    GaVoterFileImporter().load(sources, SCHEMA, conn, progress, filter)
    return progress


def _people(conn) -> dict[str, dict]:
    rel = conn.table(table_fqn(SCHEMA, "persons_validated"))
    return {row[0]: dict(zip(rel.columns, row, strict=True)) for row in rel.order("external_id").fetchall()}


def _history(conn, index: int) -> list[tuple]:
    person = _people(conn)[voter_registration_number(index)]
    return [(e["date"], e["type"], e["method"]) for e in person["voting_history"]]


def test_birth_year_becomes_january_first_date_of_birth(conn) -> None:
    _load(conn)
    years = {ext: p["date_of_birth"] for ext, p in _people(conn).items()}
    assert years["10000001"] == "1985-01-01"
    assert years["10000004"] == "1952-01-01"


def test_address_assembles_direction_type_and_unit(conn) -> None:
    _load(conn)
    person = _people(conn)["10000002"]
    assert (
        person["address_line_1"],
        person["address_line_2"],
        person["county_fips"],
        person["precinct"],
        person["gender"],
        person["race"],
    ) == (
        "4041 CONWAY VALLEY RD NW",
        None,
        "13089",
        "DEKALB-JA",
        "M",
        "black",
    )


def test_history_types_and_methods(conn) -> None:
    _load(conn)
    assert _history(conn, 1) == [
        ("2023-11-07", "other", "poll_site"),
        ("2024-03-19", "primary", "absentee"),
        ("2024-05-21", "primary", "early_voting"),
        ("2024-11-05", "general", "poll_site"),
    ]
    assert _people(conn)["10000001"]["voting_history"][0]["year"] == 2023


def test_zero_padded_history_id_joins(conn) -> None:
    _load(conn)
    assert _history(conn, 2) == [("2022-11-08", "general", "poll_site")]


def test_one_entry_per_election_and_runoff(conn) -> None:
    _load(conn)
    assert _history(conn, 4) == [
        ("2024-11-05", "general", "poll_site"),
        ("2024-12-03", "runoff", "poll_site"),
    ]


def test_unmapped_election_type_is_dropped(conn) -> None:
    _load(conn)
    assert _history(conn, 5) == []


def test_special_election(conn) -> None:
    _load(conn)
    assert _history(conn, 6) == [("2026-03-24", "special", "early_voting")]


def test_without_history_everyone_has_an_empty_history(conn) -> None:
    progress = _load(conn, {"file": SOURCES["file"]})
    assert progress.steps == GaVoterFileImporter.PROGRESS_STEPS
    assert all(p["voting_history"] == [] for p in _people(conn).values())


def test_filter_restricts_history_to_the_kept_voters(conn) -> None:
    _load(conn, filter=ImportFilter(column="county", values=["DEKALB"]))
    assert list(_people(conn)) == ["10000002"]
    assert _history(conn, 2) == [("2022-11-08", "general", "poll_site")]
