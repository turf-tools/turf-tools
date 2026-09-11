"""The dataset-level import filter: a fixed `column IN values` slice applied
before transform. Pins the SQL it compiles to, the allowlist that guards which
columns a payload may name, and the end-to-end row count on the NYC fixture.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.importers.base import ImportFilter, InvalidImportFilterError
from src.importers.nys_voter_file import NysVoterFileImporter
from src.importers.nys_voter_file.transform import nys_sboe_transformation_query

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "ny-voters-2026-03-08-10k-sample.parquet"


class _Progress:
    def advance(self, n: int = 1) -> None:
        pass


def test_no_filter_compiles_to_no_where() -> None:
    assert "WHERE" not in nys_sboe_transformation_query("raw_t")


def test_filter_compiles_to_in_clause_with_quotes_escaped() -> None:
    sql = nys_sboe_transformation_query("raw_t", ImportFilter(column="congressional_district", values=["13", "1'4"]))
    assert "WHERE raw.congressional_district IN ('13', '1''4')" in sql


def test_empty_values_means_no_filter() -> None:
    assert "WHERE" not in nys_sboe_transformation_query("raw_t", ImportFilter(column="county_code", values=[]))


def test_unlisted_column_is_rejected_before_the_source_is_read() -> None:
    # No connection needed: the allowlist check precedes the source check.
    with pytest.raises(InvalidImportFilterError, match="not available"):
        NysVoterFileImporter().load(
            "/nope/not-here.parquet", "irrelevant", None, _Progress(), ImportFilter(column="status", values=["A"])
        )


@pytest.mark.skipif(not FIXTURE.exists(), reason="NYC fixture not present")
def test_fixture_slices_to_one_congressional_district(conn) -> None:
    nyc13 = ImportFilter(column="congressional_district", values=["13"])
    table = NysVoterFileImporter().load(str(FIXTURE), "nys_voter_file_v1", conn, _Progress(), nyc13)
    (count,) = conn.execute(f"SELECT count(*) FROM {table.fqn}").fetchone()
    (total,) = conn.execute(f"SELECT count(*) FROM '{FIXTURE}' WHERE congressional_district = '13'").fetchone()
    assert count == total > 0
