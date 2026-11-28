"""Georgia-specific importer behaviour beyond the shared contract tests."""

from __future__ import annotations

import csv
import io
import zipfile
from pathlib import Path

import pytest

from src.importers.base import ImportFilter, SourceUnreadableError
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


def _history_rows() -> tuple[list[str], list[list[str]]]:
    with (SAMPLE_DATA / "history.csv").open(newline="") as f:
        rows = list(csv.reader(f))
    return rows[0], rows[1:]


def _csv_text(header: list[str], rows: list[list[str]], order: list[int]) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow([header[i] for i in order])
    writer.writerows([[row[i] for i in order] for row in rows])
    return out.getvalue()


def test_a_regular_cycle_keeps_each_election(conn) -> None:
    _load(conn)
    assert _history(conn, 1) == [
        ("2024-05-21", "primary", "absentee"),
        ("2024-06-18", "primary_runoff", "early_voting"),
        ("2024-11-05", "general", "poll_site"),
        ("2024-12-03", "general_runoff", "poll_site"),
    ]


def test_a_general_outside_november_is_a_special(conn) -> None:
    _load(conn)
    # Two methods for the November general keep the poll-site vote; the July
    # "GENERAL" and its August "GENERAL ELECTION RUNOFF" are a special election.
    assert _history(conn, 4) == [
        ("2024-11-05", "general", "poll_site"),
        ("2026-07-28", "special", "absentee"),
        ("2026-08-25", "special", "poll_site"),
    ]


def test_unlisted_labels_and_ballot_styles_are_other(conn) -> None:
    _load(conn)
    assert _history(conn, 5) == [
        ("2024-03-12", "presidential_primary", "early_voting"),
        ("2024-04-16", "other", "poll_site"),
        ("2024-11-05", "general", "other"),
    ]


def test_a_vote_without_a_type_is_kept_and_duplicates_collapse(conn) -> None:
    _load(conn)
    assert _history(conn, 6) == [("2026-06-09", "special", "absentee"), ("2026-11-03", "other", "early_voting")]


def test_last_voted_is_the_later_of_the_list_and_history(conn) -> None:
    _load(conn)
    people = _people(conn)
    assert people[voter_registration_number(1)]["last_voted_date"] == "2024-12-03"
    assert people[voter_registration_number(2)]["last_voted_date"] == "2026-05-19"
    assert people[voter_registration_number(3)]["last_voted_date"] is None


def test_last_party_is_the_newest_party_ballot(conn) -> None:
    _load(conn)
    parties = {pid: p["last_party_voted"] for pid, p in _people(conn).items()}
    assert parties == {
        voter_registration_number(1): "democratic",
        # A Democratic primary after the voter list's last vote outranks its Republican.
        voter_registration_number(2): "democratic",
        voter_registration_number(3): "non_partisan",
        voter_registration_number(4): "democratic",
        # A Republican ballot before the voter list's last vote doesn't.
        voter_registration_number(5): "democratic",
        # No party ballot on record.
        voter_registration_number(6): "none",
    }


def test_without_history_last_party_is_the_voter_lists(conn) -> None:
    _load(conn, {"file": SOURCES["file"]})
    assert _people(conn)[voter_registration_number(2)]["last_party_voted"] == "republican"


def test_birth_year_is_kept_as_a_year(conn) -> None:
    _load(conn)
    people = _people(conn)
    assert people[voter_registration_number(1)]["year_of_birth"] == 1985
    assert people[voter_registration_number(4)]["year_of_birth"] == 1952
    assert "date_of_birth" not in people[voter_registration_number(1)]


def test_address_assembles_direction_type_and_unit(conn) -> None:
    _load(conn)
    person = _people(conn)[voter_registration_number(2)]
    assert (
        person["address_line_1"],
        person["address_line_2"],
        person["county_fips"],
        person["precinct"],
        person["gender"],
        person["race"],
    ) == ("4041 CONWAY VALLEY RD NW", None, "13089", "DEKALB-JA", "M", "black")


def test_county_numbered_codes_carry_their_county(conn) -> None:
    _load(conn)
    people = _people(conn)
    assert (
        people[voter_registration_number(1)]["precinct"],
        people[voter_registration_number(1)]["county_commission_district"],
    ) == (
        "FULTON-01A",
        "FULTON-3",
    )
    assert people[voter_registration_number(2)]["county_commission_district"] == "DEKALB-2"


def test_a_county_written_with_spaces_reads_as_the_states_spelling(conn, tmp_path) -> None:
    text = (SAMPLE_DATA / "file.csv").read_text().replace('"FULTON","10000001"', '"BEN HILL","10000001"', 1)
    spaced = tmp_path / "file.csv"
    spaced.write_text(text)
    _load(conn, {"file": str(spaced)})
    person = _people(conn)[voter_registration_number(1)]
    assert (person["county_code"], person["county_fips"], person["precinct"], person["county_commission_district"]) == (
        "BENHILL",
        "13017",
        "BENHILL-01A",
        "BENHILL-3",
    )


def test_without_history_everyone_has_an_empty_history(conn) -> None:
    progress = _load(conn, {"file": SOURCES["file"]})
    assert progress.steps == GaVoterFileImporter.PROGRESS_STEPS
    assert all(p["voting_history"] == [] for p in _people(conn).values())


def test_filter_restricts_history_to_the_kept_voters(conn) -> None:
    _load(conn, filter=ImportFilter(column="county", values=["DEKALB"]))
    assert list(_people(conn)) == [voter_registration_number(2)]
    assert _history(conn, 2) == [("2024-11-05", "general", "absentee"), ("2026-05-19", "primary", "early_voting")]


def test_a_zip_of_election_files_reads_each_by_its_own_header(conn, tmp_path) -> None:
    header, rows = _history_rows()
    _load(conn)
    one_file = _people(conn)
    archive = tmp_path / "History.zip"
    columns = list(range(len(header)))
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("A-1.csv", _csv_text(header, rows[:8], columns))
        # A second file with the county first, its column headed `County`.
        moved = [1, 2, 0, *columns[3:]]
        zf.writestr("A-2.csv", _csv_text(header, rows[8:], moved).replace("County Name", "County", 1))
        zf.writestr("__MACOSX/._A-1.csv", "not a csv")
    _load(conn, {"file": SOURCES["file"], "history": str(archive)})
    assert _people(conn) == one_file


def test_a_parquet_voter_list_with_numeric_codes_reads_the_same(conn, tmp_path) -> None:
    _load(conn)
    from_csv = _people(conn)
    parquet = tmp_path / "file.parquet"
    conn.execute(f"""
        COPY (
            SELECT * REPLACE (
                CAST("Voter Registration Number" AS BIGINT) AS "Voter Registration Number",
                CAST("Congressional District" AS INTEGER) AS "Congressional District"
            )
            FROM read_csv('{SOURCES["file"]}', header=true, all_varchar=true)
        ) TO '{parquet}' (FORMAT parquet)
    """)
    _load(conn, {"file": str(parquet), "history": SOURCES["history"]})
    assert _people(conn) == from_csv


def test_a_history_file_missing_columns_says_which(conn, tmp_path) -> None:
    bad = tmp_path / "history.csv"
    bad.write_text("County Name,Voter Registration Number,Election Date\nFULTON,10000001,11/05/2024\n")
    with pytest.raises(SourceUnreadableError, match="missing voter-history columns: election_type"):
        _load(conn, {"file": SOURCES["file"], "history": str(bad)})


def test_a_voter_list_missing_fields_says_which(conn, tmp_path) -> None:
    bad = tmp_path / "file.csv"
    bad.write_text("County,Voter Registration Number\nFULTON,10000001\n")
    with pytest.raises(SourceUnreadableError, match="missing Georgia voter list fields: Status"):
        _load(conn, {"file": str(bad)})
