"""Read an NYS statewide voter file (NYSVOTER export) into `persons_raw`.

The state ships the roll as a fixed-layout, comma-delimited, fully-quoted ASCII
text file with no header (`ALLNYVOTERS<YYYYMMDD>.txt`, ~5.8 GB, 47 fields per
record). `decode_raw_to_table` turns that layout into `persons_raw`, deliberately
**faithful** — the only changes are:

  1. Name the 47 fields after the layout (`raw_column_name`: `RZIP5` → `rzip5`).
  2. Decode as Latin-1, re-encode UTF-8 (the file is labelled ASCII but carries
     Latin-1 bytes for accented names). Stray C1 control bytes (0x80-0x9F) in a
     few free-form legacy fields are dropped as garbage.
  3. Strip leading/trailing whitespace (state pads inside the quotes).
  4. Blank-after-trim → NULL.
  5. Drop purged records (STATUS `P`): no longer registered, and an export that
     includes them holds one per past county registration.

A CSV-with-header or parquet whose columns carry the layout's field names
(case-insensitive) is read against `NYS_LAYOUT` into the same `persons_raw`
shape (`tabular.load_tabular_to_table`), purged records dropped the same way.

Nothing else is touched: codes stay codes, dates stay YYYYMMDD strings, leading
zeros preserved, `voterhistory` kept as one raw string. Canonicalization is the
transform's job (`transform.py`), downstream of this.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from src.importers.base import raw_column_name
from src.importers.streams import TRIM_CHARS, source_chunks, source_extension, sql_str, stream_text_to_table
from src.importers.tabular import Layout

if TYPE_CHECKING:
    import duckdb

SourceFormat = Literal["txt", "csv", "parquet"]

# The 47 fields in source order, spelled as the official "Data File Layout for
# voter list exports from NYSVOTER" (v2.6, 2024-01-16) spells them. Order is
# significant: it is the physical column order of the headerless source file.
LAYOUT: list[str] = [
    "LASTNAME",
    "FIRSTNAME",
    "MIDDLENAME",
    "NAMESUFFIX",
    "RADDNUMBER",
    "RHALFCODE",
    "RPREDIRECTION",
    "RSTREETNAME",
    "RPOSTDIRECTION",
    "RAPARTMENTTYPE",
    "RAPARTMENT",
    "RADDRNONSTD",
    "RCITY",
    "RZIP5",
    "RZIP4",
    "MAILADD1",
    "MAILADD2",
    "MAILADD3",
    "MAILADD4",
    "DOB",
    "GENDER",
    "ENROLLMENT",
    "OTHERPARTY",
    "COUNTYCODE",
    "ED",
    "LD",
    "TOWNCITY",
    "WARD",
    "CD",
    "SD",
    "AD",
    "LASTVOTERDATE",
    "PREVYEARVOTED",
    "PREVCOUNTY",
    "PREVADDRESS",
    "PREVNAME",
    "COUNTYVRNUMBER",
    "REGDATE",
    "VRSOURCE",
    "IDREQUIRED",
    "IDMET",
    "STATUS",
    "REASONCODE",
    "INACT_DATE",
    "PURGE_DATE",
    "SBOEID",
    "VoterHistory",
]

# `persons_raw` column names, in source order.
COLUMNS: list[str] = [raw_column_name(field) for field in LAYOUT]

# The fields `transform.py` reads. A tabular source must carry these; the rest of
# the layout is optional and loads as NULL.
REQUIRED_COLUMNS: frozenset[str] = frozenset(
    {
        "lastname",
        "firstname",
        "middlename",
        "namesuffix",
        "raddnumber",
        "rhalfcode",
        "rpredirection",
        "rstreetname",
        "rpostdirection",
        "rapartmenttype",
        "rapartment",
        "rcity",
        "rzip5",
        "rzip4",
        "dob",
        "gender",
        "enrollment",
        "otherparty",
        "countycode",
        "ed",
        "cd",
        "sd",
        "ad",
        "lastvoterdate",
        "regdate",
        "status",
        "sboeid",
        "voterhistory",
    }
)

# Layout codes that are fixed-width with leading zeros (`03` for the Bronx).
# A tabular source that stores one as a number has lost those zeros; they're
# padded back on read.
ZERO_PADDED_WIDTHS: dict[str, int] = {"countycode": 2, "rzip5": 5, "rzip4": 4}

NYS_LAYOUT = Layout(
    name="NYSVOTER layout",
    examples="LASTNAME, FIRSTNAME, … SBOEID",
    fields=LAYOUT,
    required=REQUIRED_COLUMNS,
    zero_padded=ZERO_PADDED_WIDTHS,
)

# WHERE clause over the decoded columns that drops purged records.
NOT_PURGED = "WHERE status IS DISTINCT FROM 'P'"


def _read_csv_sql(stream_path: str) -> str:
    """SQL reading the UTF-8 stream as 47 VARCHAR columns c01..c47. Fully-quoted
    CSV, RFC doubled-quote escaping, no header."""
    column_struct = ", ".join(f"'c{i:02d}': 'VARCHAR'" for i in range(1, len(COLUMNS) + 1))
    return (
        "read_csv("
        f"{sql_str(stream_path)}, header=false, auto_detect=false, delim=',', "
        "quote='\"', escape='\"', all_varchar=true, strict_mode=false, "
        f"encoding='utf-8', columns={{{column_struct}}})"
    )


def _select_sql(stream_path: str) -> str:
    """SELECT trimming every field and mapping blanks to NULL, with output names,
    purged records dropped."""
    trim_set = sql_str(TRIM_CHARS)
    projections = ",\n    ".join(
        f"NULLIF(trim(c{i:02d}, {trim_set}), '') AS {column}" for i, column in enumerate(COLUMNS, start=1)
    )
    return f"SELECT * FROM (SELECT\n    {projections}\nFROM {_read_csv_sql(stream_path)}) {NOT_PURGED}"


def decode_raw_to_table(
    txt_path: str,
    table_fqn: str,
    conn: duckdb.DuckDBPyConnection,
    *,
    encoding: str = "latin-1",
) -> None:
    """Decode the raw headerless NYSVOTER layout into `table_fqn` on `conn`,
    transcoded to UTF-8 and streamed (see `stream_text_to_table`). Result: 47
    trimmed VARCHAR columns, blanks as NULL, purged records dropped."""

    stream_text_to_table(lambda: source_chunks(txt_path), _select_sql, table_fqn, conn, encoding=encoding)


def source_format(source: str) -> SourceFormat | None:
    """The source's format by extension, read off the URL path so a presigned
    query string doesn't hide it. None for anything unsupported."""
    return {".txt": "txt", ".csv": "csv", ".parquet": "parquet"}.get(source_extension(source))
