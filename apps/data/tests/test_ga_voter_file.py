"""Georgia-specific importer behaviour beyond the shared contract tests."""

from __future__ import annotations

from pathlib import Path

from src.importers.ga_voter_file import GaVoterFileImporter
from src.tables import table_fqn

SCHEMA = "ga_v1"
SAMPLE = Path(__file__).parent.parent / "src/importers/ga_voter_file/sample_data/file.csv"


class _Progress:
    def advance(self, n: int = 1) -> None:
        pass


def test_birth_year_becomes_january_first_date_of_birth(conn) -> None:
    GaVoterFileImporter().load({"file": str(SAMPLE)}, SCHEMA, conn, _Progress())
    years = {
        row[0]: row[1]
        for row in conn.execute(
            f"SELECT external_id, date_of_birth FROM {table_fqn(SCHEMA, 'persons_validated')}"
        ).fetchall()
    }
    assert years["10000001"] == "1985-01-01"
    assert years["10000004"] == "1952-01-01"


def test_address_assembles_direction_type_and_unit(conn) -> None:
    GaVoterFileImporter().load({"file": str(SAMPLE)}, SCHEMA, conn, _Progress())
    row = conn.execute(
        f"""
        SELECT address_line_1, address_line_2, county_fips, precinct, gender, race
        FROM {table_fqn(SCHEMA, 'persons_validated')}
        WHERE external_id = '10000002'
        """
    ).fetchone()
    assert row == (
        "4041 CONWAY VALLEY RD NW",
        None,
        "13089",
        "DEKALB-JA",
        "M",
        "black",
    )
