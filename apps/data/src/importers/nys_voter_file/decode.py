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

`load_tabular_to_table` reads a CSV-with-header or parquet whose columns carry
the layout's field names (case-insensitive) into the same `persons_raw` shape.

Nothing else is touched: codes stay codes, dates stay YYYYMMDD strings, leading
zeros preserved, `voterhistory` kept as one raw string. Canonicalization is the
transform's job (`transform.py`), downstream of this.
"""

from __future__ import annotations

import codecs
import csv
import os
import shutil
import tempfile
import threading
from pathlib import PurePosixPath
from typing import Literal
from urllib.parse import urlsplit

import duckdb
from src.importers.base import SourceUnreadableError, raw_column_name
from src.models import quote_ident

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
_LAYOUT_COLUMNS = frozenset(COLUMNS)

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

# Space is the only padding the state uses, but defend against stray tabs / bare
# CR/LF that survive a malformed export.
TRIM_CHARS = " \t\r\n"

# C1 control characters (U+0080..U+009F) appear as stray/corrupt bytes in a few
# free-form legacy fields. Not meaningful data; map each to None to delete it.
# Normal accented characters live at U+00A0+ and are preserved.
C1_STRIP_TABLE = {cp: None for cp in range(0x80, 0xA0)}


def sql_str(value: str) -> str:
    """Quote a Python string as a single-quoted SQL literal."""
    return "'" + value.replace("'", "''") + "'"


def _open_source(path: str):
    """Open a raw source for streaming reads. A bare path is a local file; a URL
    (`s3://`, `http(s)://`, …) is streamed via smart_open, so a multi-GB
    distribution never lands on local disk. smart_open uses boto3's credential
    chain — the same one the DuckDB S3 secret relies on."""
    if "://" in path:
        import smart_open

        return smart_open.open(path, "rb")
    return open(path, "rb")


def _feed_transcoded(input_path: str, dest_path: str, encoding: str, err: dict) -> None:
    """Stream `input_path` decoded as `encoding`, re-encoded UTF-8, to `dest_path`
    (a FIFO or file). Incremental decoder so multi-byte sequences split safely
    across read boundaries; C1 control bytes dropped. Any failure stored in `err`."""
    try:
        decoder = codecs.getincrementaldecoder(encoding)()
        with _open_source(input_path) as src, open(dest_path, "w", encoding="utf-8", newline="") as out:
            while True:
                chunk = src.read(1 << 22)  # 4 MiB
                if not chunk:
                    break
                out.write(decoder.decode(chunk).translate(C1_STRIP_TABLE))
            out.write(decoder.decode(b"", final=True).translate(C1_STRIP_TABLE))
    except BrokenPipeError:
        # DuckDB closed the read end early (parse error surfaces on its side).
        pass
    except BaseException as exc:  # noqa: BLE001 — report any failure to the caller
        err["exc"] = exc


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
    """SELECT trimming every field and mapping blanks to NULL, with output names."""
    trim_set = sql_str(TRIM_CHARS)
    projections = ",\n    ".join(
        f"NULLIF(trim(c{i:02d}, {trim_set}), '') AS {column}" for i, column in enumerate(COLUMNS, start=1)
    )
    return f"SELECT\n    {projections}\nFROM {_read_csv_sql(stream_path)}"


def decode_raw_to_table(
    txt_path: str,
    table_fqn: str,
    conn: duckdb.DuckDBPyConnection,
    *,
    encoding: str = "latin-1",
) -> None:
    """Decode the raw headerless NYSVOTER layout into `table_fqn` on `conn`.

    Transcodes to UTF-8 on the fly and streams through a FIFO (macOS/Linux) into
    a single low-memory `CREATE TABLE`; falls back to a temp file where FIFOs
    aren't available. Result: 47 trimmed VARCHAR columns, blanks as NULL."""
    work_dir = tempfile.mkdtemp(prefix="nys_decode_")
    use_fifo = hasattr(os, "mkfifo")
    stream_path = os.path.join(work_dir, "voters.utf8")
    err: dict = {}
    feeder: threading.Thread | None = None
    try:
        if use_fifo:
            os.mkfifo(stream_path)
            feeder = threading.Thread(target=_feed_transcoded, args=(txt_path, stream_path, encoding, err), daemon=True)
            feeder.start()
        else:
            _feed_transcoded(txt_path, stream_path, encoding, err)
            if "exc" in err:
                raise err["exc"]

        conn.execute(f"CREATE OR REPLACE TABLE {table_fqn} AS {_select_sql(stream_path)}")

        if feeder is not None:
            feeder.join()
        if "exc" in err:
            raise err["exc"]
    finally:
        if feeder is not None and feeder.is_alive():
            feeder.join(timeout=5)
        shutil.rmtree(work_dir, ignore_errors=True)


def source_format(source: str) -> SourceFormat | None:
    """The source's format by extension, read off the URL path so a presigned
    query string doesn't hide it. None for anything unsupported."""
    suffix = PurePosixPath(urlsplit(source).path).suffix.lower()
    return {".txt": "txt", ".csv": "csv", ".parquet": "parquet"}.get(suffix)


def csv_has_header(source: str) -> bool:
    """Whether a CSV's first row is the layout's field names rather than a voter.

    A header matches on most of its fields; a voter's name and address match on
    none, short of a coincidence like a surname of `Ward`."""
    with _open_source(source) as src:
        first = src.readline().removeprefix(codecs.BOM_UTF8).decode("latin-1")
    fields = next(csv.reader([first]), [])
    matched = sum(1 for f in fields if raw_column_name(f) in _LAYOUT_COLUMNS)
    return matched > 0 and matched * 2 >= len(fields)


def load_tabular_to_table(
    source: str,
    fmt: Literal["csv", "parquet"],
    table_fqn: str,
    conn: duckdb.DuckDBPyConnection,
) -> None:
    """Read a CSV-with-header (UTF-8 or Latin-1) or parquet into `table_fqn`, matching its
    columns to the layout by `raw_column_name` (so case doesn't matter).

    Values get the raw decode's trim + blank-to-NULL; layout fields the source
    leaves out load as NULL, unless the transform needs them. Columns outside the
    layout are ignored."""
    if fmt == "parquet":
        _load_tabular(f"read_parquet({sql_str(source)})", table_fqn, conn)
        return
    # The state's own export is Latin-1; a re-saved CSV may be either.
    for encoding in ("utf-8", "latin-1"):
        reader = f"read_csv({sql_str(source)}, header=true, all_varchar=true, encoding={sql_str(encoding)})"
        try:
            _load_tabular(reader, table_fqn, conn)
            return
        except duckdb.InvalidInputException as exc:
            if encoding != "utf-8" or "not utf-8 encoded" not in str(exc):
                raise


_NUMERIC_TYPES = ("TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT")
_FRACTIONAL_TYPES = ("FLOAT", "DOUBLE", "DECIMAL")


def _text_sql(column: str, source_column: str, source_type: str) -> str:
    """SQL reading `source_column` as the layout's text. Numbers read as their
    digits (`3.0` → `3`), and a zero-padded code gets its zeros back."""
    ident = quote_ident(source_column)
    if source_type.startswith(_NUMERIC_TYPES):
        text = f"CAST({ident} AS VARCHAR)"
    elif source_type.startswith(_FRACTIONAL_TYPES):
        text = (
            f"CASE WHEN {ident} = trunc({ident}) THEN CAST(CAST({ident} AS HUGEINT) AS VARCHAR) "
            f"ELSE CAST({ident} AS VARCHAR) END"
        )
    else:
        return f"CAST({ident} AS VARCHAR)"
    width = ZERO_PADDED_WIDTHS.get(column)
    return f"lpad({text}, {width}, '0')" if width else text


def _load_tabular(reader: str, table_fqn: str, conn: duckdb.DuckDBPyConnection) -> None:
    described = conn.execute(f"DESCRIBE SELECT * FROM {reader}").fetchall()
    source_columns = [row[0] for row in described]
    source_types = {row[0]: row[1] for row in described}

    # DuckDB suffixes a case-variant duplicate (`rzip5_1`), so names are unique
    # here and a duplicate simply doesn't match.
    source_by_column = {raw_column_name(c): c for c in source_columns if raw_column_name(c) in _LAYOUT_COLUMNS}

    if not source_by_column:
        raise SourceUnreadableError(
            "None of the file's columns match the NYSVOTER layout field names (LASTNAME, FIRSTNAME, … SBOEID). "
            "Name the columns after the layout's fields; case doesn't matter."
        )
    missing = [
        field
        for field, column in zip(LAYOUT, COLUMNS, strict=True)
        if column in REQUIRED_COLUMNS and column not in source_by_column
    ]
    if missing:
        raise SourceUnreadableError(
            f"The file is missing NYSVOTER layout fields: {', '.join(missing)}. "
            "Name the columns after the layout's fields; case doesn't matter."
        )

    trim_set = sql_str(TRIM_CHARS)
    projections = ",\n    ".join(
        f"NULLIF(trim({_text_sql(column, source_by_column[column], source_types[source_by_column[column]])}, "
        f"{trim_set}), '') AS {column}"
        if column in source_by_column
        else f"CAST(NULL AS VARCHAR) AS {column}"
        for column in COLUMNS
    )
    conn.execute(f"CREATE OR REPLACE TABLE {table_fqn} AS SELECT\n    {projections}\nFROM {reader}")
