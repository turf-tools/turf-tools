"""Read a Georgia SOS voter-list CSV (or parquet) into `persons_raw`.

The Secretary of State ships ordered voter lists as a quoted CSV with a header
row (county extracts and the statewide file share the same columns). Field
names match the header observed on recent SOS deliveries. Values are read
faithfully: trimmed, blanks as NULL. Canonicalization is the transform's job.
"""

from __future__ import annotations

import codecs
import csv
from pathlib import PurePosixPath
from typing import Literal
from urllib.parse import urlsplit

import duckdb
from src.importers.base import SourceUnreadableError, raw_column_name, redact_source
from src.importers.streams import open_source, sql_str
from src.models import quote_ident

SourceFormat = Literal["csv", "parquet"]

# Header spelling as delivered by the SOS voter-list CSV. Order matches the
# file; decode accepts any order when reading by name.
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

COLUMNS: list[str] = [raw_column_name(field) for field in LAYOUT]
_LAYOUT_COLUMNS = frozenset(COLUMNS)

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

TRIM_CHARS = " \t\r\n"


def source_format(source: str) -> SourceFormat | None:
    """The source's format by extension. None for anything unsupported."""
    suffix = PurePosixPath(urlsplit(source).path).suffix.lower()
    return {".csv": "csv", ".parquet": "parquet"}.get(suffix)


def csv_has_header(source: str) -> bool:
    """Whether a CSV's first row names layout fields rather than a voter."""
    with open_source(source) as src:
        first = src.readline().removeprefix(codecs.BOM_UTF8).decode("utf-8", errors="replace")
    fields = next(csv.reader([first]), [])
    matched = sum(1 for f in fields if raw_column_name(f) in _LAYOUT_COLUMNS)
    return matched > 0 and matched * 2 >= len(fields)


def load_tabular_to_table(
    source: str,
    fmt: SourceFormat,
    table_fqn: str,
    conn: duckdb.DuckDBPyConnection,
) -> None:
    """Read a CSV-with-header or parquet into `table_fqn`, matching columns to
    the layout by `raw_column_name`. Layout fields the source leaves out load
    as NULL; columns outside the layout are ignored."""
    if "://" not in source:
        import os

        if not os.path.exists(source):
            raise SourceUnreadableError(f"Import source not found: {redact_source(source)!r}")
    if fmt == "parquet":
        _load_tabular(f"read_parquet({sql_str(source)})", table_fqn, conn)
        return
    if not csv_has_header(source):
        raise SourceUnreadableError(f"{redact_source(source)!r} is missing the Georgia voter-list header row.")
    for encoding in ("utf-8", "latin-1"):
        reader = (
            f"read_csv({sql_str(source)}, header=true, all_varchar=true, encoding={sql_str(encoding)}, sample_size=-1)"
        )
        try:
            _load_tabular(reader, table_fqn, conn)
            return
        except duckdb.InvalidInputException as exc:
            if encoding != "utf-8" or "not utf-8 encoded" not in str(exc):
                raise


_NUMERIC_TYPES = (
    "TINYINT",
    "SMALLINT",
    "INTEGER",
    "BIGINT",
    "HUGEINT",
    "UTINYINT",
    "USMALLINT",
    "UINTEGER",
    "UBIGINT",
)
_FRACTIONAL_TYPES = ("FLOAT", "DOUBLE", "DECIMAL")


def _text_sql(column: str, source_column: str, source_type: str) -> str:
    """SQL reading `source_column` as layout text."""
    ident = quote_ident(source_column)
    if source_type.startswith(_NUMERIC_TYPES):
        return f"CAST({ident} AS VARCHAR)"
    if source_type.startswith(_FRACTIONAL_TYPES):
        return (
            f"CASE WHEN {ident} = trunc({ident}) THEN CAST(CAST({ident} AS HUGEINT) AS VARCHAR) "
            f"ELSE CAST({ident} AS VARCHAR) END"
        )
    return f"CAST({ident} AS VARCHAR)"


def _load_tabular(reader_sql: str, table_fqn: str, conn: duckdb.DuckDBPyConnection) -> None:
    describe = conn.execute(f"DESCRIBE SELECT * FROM {reader_sql}").fetchall()
    by_name = {raw_column_name(name): (name, typ) for name, typ, *_ in describe}
    missing = sorted(REQUIRED_COLUMNS - set(by_name))
    if missing:
        raise SourceUnreadableError(f"Voter file is missing required columns: {', '.join(missing)}.")
    trim_set = sql_str(TRIM_CHARS)
    projections = []
    for column in COLUMNS:
        if column in by_name:
            source_column, source_type = by_name[column]
            text = _text_sql(column, source_column, source_type)
            projections.append(f"NULLIF(trim({text}, {trim_set}), '') AS {column}")
        else:
            projections.append(f"CAST(NULL AS VARCHAR) AS {column}")
    conn.execute(
        f"CREATE OR REPLACE TABLE {table_fqn} AS SELECT\n    " + ",\n    ".join(projections) + f"\nFROM {reader_sql}"
    )
