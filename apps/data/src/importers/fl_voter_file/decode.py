"""Read the Florida voter extract's two zips into raw tables.

The Division of Elections ships the roll monthly as two zips of 67 per-county,
tab-delimited ASCII files with no header and CRLF line endings (layout:
"Voter Extract File Layout", May 2026):

- registration: `<CNT>_<YYYYMMDD>.txt`, 38 fields per voter.
- history: `<CNT>_H_<YYYYMMDD>.txt`, 5 fields per vote cast.

Members are found by name, not by the zip's own filename, which the layout
documents inconsistently. Each zip's county files are streamed back to back into
one table, read faithfully: fields named after the layout (`raw_column_name`),
whitespace trimmed, blanks as NULL, quoting off (stray `"` appear in names and
addresses). The one exception is the registration's exempt rows (field 7 = `Y`),
dropped here: every protected field on them is `*`, so they carry no name or
address to canvass.
"""

from __future__ import annotations

import os
import re
import zipfile
from typing import TYPE_CHECKING

from src.importers.base import SourceUnreadableError, raw_column_name, redact_source
from src.importers.streams import open_source, read_chunks, sql_str, stream_text_to_table

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    import duckdb

REGISTRATION_LAYOUT: list[str] = [
    "County Code",
    "Voter ID",
    "Name Last",
    "Name Suffix",
    "Name First",
    "Name Middle",
    "Requested public records exemption",
    "Residence Address Line 1",
    "Residence Address Line 2",
    "Residence City (USPS)",
    "Residence State",
    "Residence Zipcode",
    "Mailing Address Line 1",
    "Mailing Address Line 2",
    "Mailing Address Line 3",
    "Mailing City",
    "Mailing State",
    "Mailing Zipcode",
    "Mailing Country",
    "Gender",
    "Race",
    "Birth Date",
    "Registration Date",
    "Party Affiliation",
    "Precinct",
    "Precinct Group",
    "Precinct Split",
    "Precinct Suffix",
    "Voter Status",
    "Congressional District",
    "House District",
    "Senate District",
    "County Commission District",
    "School Board District",
    "Daytime Area Code",
    "Daytime Phone Number",
    "Daytime Phone Extension",
    "Email address",
]

HISTORY_LAYOUT: list[str] = [
    "County Code",
    "Voter ID",
    "Election Date",
    "Election Type",
    "History Code",
]

REGISTRATION_COLUMNS = [raw_column_name(f) for f in REGISTRATION_LAYOUT]
HISTORY_COLUMNS = [raw_column_name(f) for f in HISTORY_LAYOUT]

_REGISTRATION_MEMBER = re.compile(r"^[A-Z]{3}_\d{8}\.txt$")
_HISTORY_MEMBER = re.compile(r"^[A-Z]{3}_H_\d{8}\.txt$")

TRIM_CHARS = " \t\r\n"


def _members(zf: zipfile.ZipFile, pattern: re.Pattern[str]) -> list[zipfile.ZipInfo]:
    """The zip's county files, by base name, in name order."""
    found = [i for i in zf.infolist() if not i.is_dir() and pattern.match(i.filename.rsplit("/", 1)[-1])]
    return sorted(found, key=lambda i: i.filename)


def _zip_chunks(source: str, pattern: re.Pattern[str]) -> Iterator[bytes]:
    """Every matching member's bytes, back to back, each ending in a newline."""
    with open_source(source) as raw, zipfile.ZipFile(raw) as zf:
        for info in _members(zf, pattern):
            last = b"\n"
            with zf.open(info) as member:
                for chunk in read_chunks(member):
                    last = chunk[-1:]
                    yield chunk
            if last != b"\n":
                yield b"\r\n"


def _check_zip(source: str, pattern: re.Pattern[str], expected: str) -> None:
    """Fail with a readable message unless `source` is a zip holding county files."""
    if "://" not in source and not os.path.exists(source):
        raise SourceUnreadableError(f"Import source not found: {redact_source(source)!r}")
    try:
        with open_source(source) as raw, zipfile.ZipFile(raw) as zf:
            found = bool(_members(zf, pattern))
    except (OSError, zipfile.BadZipFile) as exc:
        raise SourceUnreadableError(
            f"Could not read {redact_source(source)!r} as a zip. Check that it exists and is reachable."
        ) from exc
    if not found:
        raise SourceUnreadableError(f"{redact_source(source)!r} has no {expected} files in it.")


def _select_sql(columns: list[str], where: str = "") -> Callable[[str], str]:
    """SQL reading the UTF-8 stream as `columns`, trimmed, blanks as NULL, then `where`."""

    def select(stream_path: str) -> str:
        struct = ", ".join(f"'c{i:02d}': 'VARCHAR'" for i in range(1, len(columns) + 1))
        trim_set = sql_str(TRIM_CHARS)
        projections = ",\n    ".join(
            f"NULLIF(trim(c{i:02d}, {trim_set}), '') AS {column}" for i, column in enumerate(columns, start=1)
        )
        reader = (
            f"read_csv({sql_str(stream_path)}, header=false, auto_detect=false, delim='\\t', "
            "quote='', escape='', all_varchar=true, strict_mode=false, null_padding=true, "
            f"columns={{{struct}}})"
        )
        return f"SELECT * FROM (SELECT\n    {projections}\nFROM {reader}) {where}"

    return select


def read_registration(source: str, table_fqn: str, conn: duckdb.DuckDBPyConnection) -> None:
    """The registration zip's county files → `table_fqn`, exempt rows dropped."""
    _check_zip(source, _REGISTRATION_MEMBER, "voter registration (CNT_YYYYMMDD.txt)")
    stream_text_to_table(
        lambda: _zip_chunks(source, _REGISTRATION_MEMBER),
        _select_sql(
            REGISTRATION_COLUMNS,
            "WHERE requested_public_records_exemption IS DISTINCT FROM 'Y'",
        ),
        table_fqn,
        conn,
        encoding="latin-1",
    )


def read_history(source: str, table_fqn: str, conn: duckdb.DuckDBPyConnection) -> None:
    """The history zip's county files → `table_fqn`."""
    _check_zip(source, _HISTORY_MEMBER, "voting history (CNT_H_YYYYMMDD.txt)")
    stream_text_to_table(
        lambda: _zip_chunks(source, _HISTORY_MEMBER),
        _select_sql(HISTORY_COLUMNS),
        table_fqn,
        conn,
        encoding="latin-1",
    )


def create_empty_history(table_fqn: str, conn: duckdb.DuckDBPyConnection) -> None:
    """An empty history table, for an import without the history zip."""
    columns = ", ".join(f"{c} VARCHAR" for c in HISTORY_COLUMNS)
    conn.execute(f"CREATE OR REPLACE TABLE {table_fqn} ({columns})")
