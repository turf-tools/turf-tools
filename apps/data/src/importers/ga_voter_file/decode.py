"""Read Georgia SOS voter-list and voter-history files into raw tables.

Voter list: the ordered voter-list CSV (county extracts and the statewide file
share its columns) with a header row, or a parquet with the same column names,
read by name (`tabular.load_tabular_to_table`). History: the free per-election
CSVs from mvp.sos.ga.gov, one election per file, or a zip of them. Each history
file's columns are matched by name from its own header, since their order
varies between files, and the files are streamed one after another into one table.
Values are read faithfully: trimmed, blanks as NULL. Canonicalization is the
transform's job.
"""

from __future__ import annotations

import codecs
import csv
import re
from typing import TYPE_CHECKING, Literal

from src.importers.base import SourceUnreadableError, raw_column_name, redact_source
from src.importers.streams import (
    TRIM_CHARS,
    check_source_exists,
    check_zip,
    first_line,
    source_chunks,
    source_extension,
    sql_str,
    stream_text_to_table,
    zip_member_chunks,
)
from src.importers.tabular import Layout

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    import duckdb

SourceFormat = Literal["csv", "parquet"]

# The voter list's fields as the SOS header spells them, in file order.
LAYOUT: list[str] = [
    "County",
    "Voter Registration Number",
    "Status",
    "Status Reason",
    "Last Name",
    "First Name",
    "Middle Name",
    "Suffix",
    "Birth Year",
    "Residence Street Number",
    "Residence Pre Direction",
    "Residence Street Name",
    "Residence Street Type",
    "Residence Post Direction",
    "Residence Apt Unit Number",
    "Residence City",
    "Residence Zipcode",
    "County Precinct",
    "County Precinct Description",
    "Municipal Precinct",
    "Municipal Precinct Description",
    "Congressional District",
    "State Senate District",
    "State House District",
    "Judicial District",
    "County Commission District",
    "School Board District",
    "City Council District",
    "Municipal School Board District",
    "Water Board District",
    "Super Council District",
    "Super Commissioner District",
    "Super School Board District",
    "Fire District",
    "Municipality",
    "Combo",
    "Land Lot",
    "Land District",
    "Registration Date",
    "Race",
    "Gender",
    "Last Modified Date",
    "Date of Last Contact",
    "Last Party Voted",
    "Last Vote Date",
    "Voter Created Date",
    "Mailing Street Number",
    "Mailing Street Name",
    "Mailing Apt Unit Number",
    "Mailing City",
    "Mailing Zipcode",
    "Mailing State",
    "Mailing Country",
]

REQUIRED_COLUMNS: frozenset[str] = frozenset(
    {
        "county",
        "voter_registration_number",
        "status",
        "last_name",
        "first_name",
        "middle_name",
        "suffix",
        "birth_year",
        "residence_street_number",
        "residence_pre_direction",
        "residence_street_name",
        "residence_street_type",
        "residence_post_direction",
        "residence_apt_unit_number",
        "residence_city",
        "residence_zipcode",
        "county_precinct",
        "congressional_district",
        "state_senate_district",
        "state_house_district",
        "registration_date",
        "race",
        "gender",
        "last_vote_date",
    }
)


# Codes the voter list writes with leading zeros, padded back when a parquet
# stores them as numbers.
ZERO_PADDED_WIDTHS: dict[str, int] = {
    "voter_registration_number": 8,
    "residence_zipcode": 5,
    "congressional_district": 3,
    "state_senate_district": 3,
    "state_house_district": 3,
}

GA_LAYOUT = Layout(
    name="Georgia voter list",
    examples="County, Voter Registration Number, … Mailing Country",
    fields=LAYOUT,
    required=REQUIRED_COLUMNS,
    zero_padded=ZERO_PADDED_WIDTHS,
)

# mvp.sos.ga.gov voter-history header, as recent files spell it. Column order
# varies between files; a `County` column is read as `County Name`.
HISTORY_LAYOUT: list[str] = [
    "County Name",
    "Voter Registration Number",
    "Election Date",
    "Election Type",
    "Party",
    "Ballot Style",
    "Absentee",
    "Provisional",
    "Supplemental",
]
HISTORY_COLUMNS: list[str] = [raw_column_name(field) for field in HISTORY_LAYOUT]
_HISTORY_REQUIRED = ("voter_registration_number", "election_date", "election_type")
_HISTORY_ALIASES: dict[str, str] = {"county": "county_name"}

_HISTORY_MEMBER = re.compile(r".*\.csv$", re.IGNORECASE)


def source_format(source: str) -> SourceFormat | None:
    """The voter list's format by extension. None if unsupported."""
    return {".csv": "csv", ".parquet": "parquet"}.get(source_extension(source))


def create_empty_history(table_fqn: str, conn: duckdb.DuckDBPyConnection) -> None:
    """An empty history table, for an import without history files."""
    columns = ", ".join(f"{c} VARCHAR" for c in HISTORY_COLUMNS)
    conn.execute(f"CREATE OR REPLACE TABLE {table_fqn} ({columns})")


def read_history(source: str, table_fqn: str, conn: duckdb.DuckDBPyConnection) -> None:
    """A history `.csv`, or every `.csv` in a history `.zip`, → `table_fqn`."""
    extension = source_extension(source)
    if extension not in (".csv", ".zip"):
        raise SourceUnreadableError(f"{redact_source(source)!r} must be a .csv voter-history file or a .zip of them.")
    create_empty_history(table_fqn, conn)
    if extension == ".csv":
        check_source_exists(source)
        _append_history(source, None, lambda: source_chunks(source), table_fqn, conn)
        return
    for member in check_zip(source, _HISTORY_MEMBER, "voter-history (.csv)"):
        _append_history(source, member, lambda m=member: zip_member_chunks(source, m), table_fqn, conn)


def _append_history(
    source: str,
    member: str | None,
    chunks: Callable[[], Iterator[bytes]],
    table_fqn: str,
    conn: duckdb.DuckDBPyConnection,
) -> None:
    """Stream one history file onto `table_fqn`, its columns matched by name
    from its own header row."""
    name = member or redact_source(source)
    header = first_line(source, member).removeprefix(codecs.BOM_UTF8).decode("latin-1")
    fields = next(csv.reader([header]), [])
    positions: dict[str, int] = {}
    for i, field in enumerate(fields, start=1):
        column = raw_column_name(field)
        column = _HISTORY_ALIASES.get(column, column)
        if column in HISTORY_COLUMNS:
            positions.setdefault(column, i)
    missing = [c for c in _HISTORY_REQUIRED if c not in positions]
    if missing:
        raise SourceUnreadableError(f"{name!r} is missing voter-history columns: {', '.join(missing)}.")

    def select(stream_path: str) -> str:
        struct = ", ".join(f"'c{i:02d}': 'VARCHAR'" for i in range(1, len(fields) + 1))
        trim_set = sql_str(TRIM_CHARS)
        projections = ",\n    ".join(
            f"NULLIF(trim(c{positions[column]:02d}, {trim_set}), '') AS {column}"
            if column in positions
            else f"CAST(NULL AS VARCHAR) AS {column}"
            for column in HISTORY_COLUMNS
        )
        reader = (
            f"read_csv({sql_str(stream_path)}, header=true, auto_detect=false, delim=',', quote='\"', "
            f"escape='\"', all_varchar=true, strict_mode=false, null_padding=true, columns={{{struct}}})"
        )
        return f"SELECT\n    {projections}\nFROM {reader}"

    stream_text_to_table(chunks, select, table_fqn, conn, encoding="latin-1", append=True)
