"""Florida-specific import behaviour, on the committed sample (see its
`make_sample.py` for what each invented voter exercises)."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.importers.base import ImportFilter, SourceUnreadableError
from src.importers.fl_voter_file import FlVoterFileImporter
from src.importers.fl_voter_file.sample_data.make_sample import PEOPLE, voter_id
from src.tables import table_fqn

SCHEMA = "fl_v1"
SAMPLE_DATA = Path(__file__).parent.parent / "src/importers/fl_voter_file/sample_data"
SOURCES = {"detail": str(SAMPLE_DATA / "detail.zip"), "history": str(SAMPLE_DATA / "history.zip")}


class _Progress:
    def __init__(self) -> None:
        self.steps = 0

    def advance(self, n: int = 1) -> None:
        self.steps += n


def _load(conn, sources=SOURCES, filter: ImportFilter | None = None) -> _Progress:
    progress = _Progress()
    FlVoterFileImporter().load(sources, SCHEMA, conn, progress, filter)
    return progress


def _people(conn) -> dict[str, dict]:
    rel = conn.table(table_fqn(SCHEMA, "persons_validated"))
    return {row[0]: dict(zip(rel.columns, row, strict=True)) for row in rel.order("external_id").fetchall()}


def _person(conn, index: int) -> dict:
    return _people(conn)[voter_id(index)]


def test_exempt_voters_are_dropped(conn) -> None:
    _load(conn)
    people = _people(conn)
    assert len(people) == len(PEOPLE) - 1
    assert voter_id(len(PEOPLE)) not in people
    assert conn.sql(f"SELECT count(*) FROM {table_fqn(SCHEMA, 'persons_raw')}").fetchone()[0] == len(PEOPLE) - 1


def test_address_line_1_is_collapsed_and_the_half_split_off(conn) -> None:
    _load(conn)
    assert _person(conn, 1)["address_line_1"] == "1724 NW 38Th St"
    assert _person(conn, 1)["address_line_2"] == "APT 201"
    assert _person(conn, 3)["address_line_1"] == "2001 Biscayne BLVD"
    half = _person(conn, 2)
    assert (half["address_line_1"], half["half_code"]) == ("2215 NE 123Rd ST", "1/2")
    assert _person(conn, 1)["half_code"] is None


def test_zip_plus_four_is_split_and_state_filled(conn) -> None:
    _load(conn)
    person = _person(conn, 7)
    assert (person["zip5"], person["zip4"], person["state"]) == ("33172", "4778", "FL")
    assert _person(conn, 1)["zip4"] is None


def test_zip_filter_matches_zip_plus_four(conn) -> None:
    _load(conn, filter=ImportFilter(column="residence_zipcode", values=["33172"]))
    assert list(_people(conn)) == [voter_id(7)]


def test_county_level_codes_carry_their_county(conn) -> None:
    _load(conn)
    miami, broward = _person(conn, 1), _person(conn, 9)
    assert (miami["precinct"], broward["precinct"]) == ("DAD-033", "BRO-033")
    assert (miami["county_fips"], broward["county_fips"]) == ("12086", "12011")
    assert miami["congressional_district"] == "25"


def test_codes_map_to_canonical_labels(conn) -> None:
    _load(conn)
    people = [_person(conn, i) for i in range(1, len(PEOPLE))]
    assert [p["enrollment"] for p in people] == [
        "democratic",
        "republican",
        "unaffiliated",
        "democratic",
        "other",  # AMF
        "independent",  # IND, the Independent Party of Florida
        "democratic",
        "libertarian",
        "green",
        "conservative",
    ]
    assert _person(conn, 3)["registration_status"] == "inactive"
    assert _person(conn, 5)["race"] == "black"
    assert _person(conn, 1)["date_of_birth"] == "1980-01-15"
    assert _person(conn, 8)["date_of_birth"] is None
    assert _person(conn, 1)["registration_date"] == "2008-09-15"


def test_phone_needs_an_area_code_and_email_is_lowercased(conn) -> None:
    _load(conn)
    blake = _person(conn, 2)
    assert (blake["phone"], blake["email"]) == ("3055551234", "blake.sample@example.com")
    assert _person(conn, 4)["phone"] is None
    assert _person(conn, 4)["last_name"] == 'O"Example'


def _history(conn, index: int) -> list[tuple]:
    return [(e["date"], e["type"], e["method"]) for e in _person(conn, index)["voting_history"]]


def test_history_types_and_methods(conn) -> None:
    _load(conn)
    assert _history(conn, 1) == [
        ("2023-11-07", "other", "poll_site"),
        ("2024-03-19", "presidential_primary", "absentee"),
        ("2024-08-20", "primary", "early_voting"),
        ("2024-11-05", "general", "poll_site"),
    ]
    assert _person(conn, 1)["voting_history"][0]["year"] == 2023


def test_one_entry_per_election_and_only_counted_ballots(conn) -> None:
    _load(conn)
    # Two counted codes for one election → the poll-site one.
    assert _history(conn, 2) == [("2022-11-08", "general", "early_voting"), ("2024-11-05", "general", "poll_site")]
    # B, L, P, and N aren't votes.
    assert _history(conn, 3) == []
    # Exact duplicate rows collapse; a runoff keeps its type.
    assert _history(conn, 4) == [("2024-11-05", "general", "poll_site"), ("2026-06-02", "runoff", "poll_site")]


def test_gen_and_pri_off_the_regular_dates_are_specials(conn) -> None:
    _load(conn)
    assert _history(conn, 6) == [("2024-11-05", "general", "early_voting"), ("2026-03-24", "special", "poll_site")]
    assert _history(conn, 7) == [
        ("2024-11-05", "general", "absentee"),
        ("2025-01-28", "special", "early_voting"),
        ("2025-04-01", "special", "poll_site"),
    ]


def test_history_joins_on_voter_id_across_counties(conn) -> None:
    _load(conn)
    assert _history(conn, 5) == [("2022-11-08", "general", "poll_site")]


def test_without_history_everyone_has_an_empty_history(conn) -> None:
    progress = _load(conn, {"detail": SOURCES["detail"]})
    assert progress.steps == FlVoterFileImporter.PROGRESS_STEPS
    assert all(p["voting_history"] == [] for p in _people(conn).values())


def test_filter_restricts_history_to_the_kept_voters(conn) -> None:
    _load(conn, filter=ImportFilter(column="county_code", values=["BRO"]))
    assert list(_people(conn)) == [voter_id(9), voter_id(10)]
    assert _history(conn, 9) == [("2024-08-20", "primary", "poll_site"), ("2024-11-05", "general", "poll_site")]


def test_swapped_zips_are_rejected_by_their_contents(conn) -> None:
    swapped = {"detail": SOURCES["history"], "history": SOURCES["detail"]}
    with pytest.raises(SourceUnreadableError, match="no voter registration"):
        _load(conn, swapped)


def test_a_non_zip_is_rejected(conn, tmp_path) -> None:
    not_zip = tmp_path / "voters.zip"
    not_zip.write_text("not a zip", encoding="utf-8")
    with pytest.raises(SourceUnreadableError, match="as a zip"):
        _load(conn, {"detail": str(not_zip)})


def test_history_grouped_in_batches_matches_one_pass(conn, monkeypatch) -> None:
    _load(conn)
    one_pass = _people(conn)
    monkeypatch.setattr("src.importers.fl_voter_file.importer.VOTES_PER_BATCH", 2)
    _load(conn)
    assert _people(conn) == one_pass


def test_a_missing_local_file_says_so(conn, tmp_path) -> None:
    with pytest.raises(SourceUnreadableError, match="not found"):
        _load(conn, {"detail": str(tmp_path / "nope.zip")})
