"""Updates that build on an earlier version: sources kept or added to."""

from __future__ import annotations

import csv
from pathlib import Path

import pytest

from src.importers.base import ImportFilter, InvalidImportSourcesError, SourceUnreadableError, check_import_inputs
from src.importers.fl_voter_file import FlVoterFileImporter
from src.importers.ga_voter_file import GaVoterFileImporter
from src.tables import table_fqn

GA_SAMPLE = Path(__file__).parent.parent / "src/importers/ga_voter_file/sample_data"
FL_SAMPLE = Path(__file__).parent.parent / "src/importers/fl_voter_file/sample_data"


class _Progress:
    def advance(self, n: int = 1) -> None:
        pass


def _ga(conn, schema: str, sources: dict[str, str], base: str | None = None, filter=None) -> dict[str, list]:
    GaVoterFileImporter().load(sources, schema, conn, _Progress(), filter, base)
    rows = conn.sql(f"SELECT external_id, voting_history FROM {table_fqn(schema, 'persons_validated')}").fetchall()
    return {pid: [(e["date"], e["type"]) for e in history] for pid, history in rows}


def _split_history(tmp_path: Path) -> tuple[str, str]:
    """The sample history as two files: the 2024 elections, then the 2026 ones."""
    with (GA_SAMPLE / "history.csv").open(newline="") as f:
        header, *rows = list(csv.reader(f))
    paths = []
    for name, keep in (("2024.csv", "2024"), ("2026.csv", "2026")):
        path = tmp_path / name
        with path.open("w", newline="") as out:
            writer = csv.writer(out)
            writer.writerow(header)
            writer.writerows(r for r in rows if r[0].endswith(keep))
        paths.append(str(path))
    return paths[0], paths[1]


FILE = str(GA_SAMPLE / "file.csv")


def test_an_update_with_one_election_adds_it_to_the_kept_voter_list(conn, tmp_path) -> None:
    early, late = _split_history(tmp_path)
    everything = _ga(conn, "all_v1", {"file": FILE, "history": str(GA_SAMPLE / "history.csv")})
    _ga(conn, "ga_v1", {"file": FILE, "history": early})
    assert _ga(conn, "ga_v2", {"history": late}, base="ga_v1") == everything


def test_a_new_voter_list_alone_keeps_the_elections(conn, tmp_path) -> None:
    first = _ga(conn, "ga_v1", {"file": FILE, "history": str(GA_SAMPLE / "history.csv")})
    assert _ga(conn, "ga_v2", {"file": FILE}, base="ga_v1") == first


def test_adding_an_election_twice_changes_nothing(conn) -> None:
    sources = {"file": FILE, "history": str(GA_SAMPLE / "history.csv")}
    first = _ga(conn, "ga_v1", sources)
    assert _ga(conn, "ga_v2", {"history": sources["history"]}, base="ga_v1") == first
    v1, v2 = (
        conn.sql(f"SELECT count(*) FROM {table_fqn(v, 'voting_history_raw')}").fetchone() for v in ("ga_v1", "ga_v2")
    )
    assert v1 == v2


def test_a_filtered_dataset_keeps_only_its_rows(conn) -> None:
    dekalb = ImportFilter(column="county", values=["DEKALB"])
    _ga(conn, "ga_v1", {"file": FILE}, filter=dekalb)
    raw = conn.sql(f"SELECT DISTINCT county FROM {table_fqn('ga_v1', 'persons_raw')}").fetchall()
    assert raw == [("DEKALB",)]
    assert list(_ga(conn, "ga_v2", {"history": str(GA_SAMPLE / "history.csv")}, "ga_v1", dekalb)) == ["10000002"]


def test_a_base_without_the_stored_table_says_so(conn) -> None:
    conn.execute("CREATE SCHEMA empty_v1")
    with pytest.raises(SourceUnreadableError, match="no stored voter file"):
        _ga(conn, "ga_v2", {"history": str(GA_SAMPLE / "history.csv")}, base="empty_v1")


def test_a_replace_source_left_blank_is_empty_on_update(conn) -> None:
    sources = {"detail": str(FL_SAMPLE / "detail.zip"), "history": str(FL_SAMPLE / "history.zip")}
    FlVoterFileImporter().load(sources, "fl_v1", conn, _Progress())
    FlVoterFileImporter().load({"detail": sources["detail"]}, "fl_v2", conn, _Progress(), None, "fl_v1")
    histories = conn.sql(f"SELECT DISTINCT voting_history FROM {table_fqn('fl_v2', 'persons_validated')}").fetchall()
    assert histories == [([],)]


def test_a_kept_source_is_required_only_on_a_first_import() -> None:
    with pytest.raises(InvalidImportSourcesError, match="Missing Voter file"):
        check_import_inputs(GaVoterFileImporter, {"history": "h.csv"}, None)
    check_import_inputs(GaVoterFileImporter, {"history": "h.csv"}, None, update=True)
    with pytest.raises(InvalidImportSourcesError, match="Missing Voter detail"):
        check_import_inputs(FlVoterFileImporter, {"history": "h.zip"}, None, update=True)


def test_an_update_needs_at_least_one_file() -> None:
    with pytest.raises(InvalidImportSourcesError, match="Nothing to import"):
        check_import_inputs(GaVoterFileImporter, {"file": " ", "history": ""}, None, update=True)
