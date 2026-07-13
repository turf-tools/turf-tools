"""Decode the raw NYS statewide voter file (NYSVOTER export) into a table.

The state ships the roll as a fixed-layout, comma-delimited, fully-quoted ASCII
text file with no header (`ALLNYVOTERS<YYYYMMDD>.txt`, ~5.8 GB, 47 fields per
record). This turns that into `persons_raw`, deliberately **faithful** — the only
changes are:

  1. Assign the 47 official fields their snake_case names (1:1, in source order).
  2. Decode as Latin-1, re-encode UTF-8 (the file is labelled ASCII but carries
     Latin-1 bytes for accented names). Stray C1 control bytes (0x80-0x9F) in a
     few free-form legacy fields are dropped as garbage.
  3. Strip leading/trailing whitespace (state pads inside the quotes).
  4. Blank-after-trim → NULL.

Nothing else is touched: codes stay codes, dates stay YYYYMMDD strings, leading
zeros preserved, `voter_history` kept as one raw string. Canonicalization is the
transform's job (`transform.py`), downstream of this.

Vendored from https://github.com/freeman-lab/parse-voter-file (MIT), adapted to
stream into an existing DuckDB/DuckLake connection instead of a standalone file.
"""

from __future__ import annotations

import codecs
import os
import shutil
import tempfile
import threading
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import duckdb

# The 47 fields in source order → snake_case output names. Order is significant:
# it is the physical column order of the source file. From the official
# "Data File Layout for voter list exports from NYSVOTER" (v2.6, 2024-01-16).
COLUMNS: list[tuple[str, str]] = [
    ("LASTNAME", "last_name"),
    ("FIRSTNAME", "first_name"),
    ("MIDDLENAME", "middle_name"),
    ("NAMESUFFIX", "name_suffix"),
    ("RADDNUMBER", "res_house_number"),
    ("RHALFCODE", "res_half_code"),
    ("RPREDIRECTION", "res_pre_direction"),
    ("RSTREETNAME", "res_street_name"),
    ("RPOSTDIRECTION", "res_post_direction"),
    ("RAPARTMENTTYPE", "res_apartment_type"),
    ("RAPARTMENT", "res_apartment"),
    ("RADDRNONSTD", "res_addr_non_standard"),
    ("RCITY", "res_city"),
    ("RZIP5", "res_zip5"),
    ("RZIP4", "res_zip4"),
    ("MAILADD1", "mail_addr_1"),
    ("MAILADD2", "mail_addr_2"),
    ("MAILADD3", "mail_addr_3"),
    ("MAILADD4", "mail_addr_4"),
    ("DOB", "date_of_birth"),
    ("GENDER", "gender"),
    ("ENROLLMENT", "enrollment"),
    ("OTHERPARTY", "other_party"),
    ("COUNTYCODE", "county_code"),
    ("ED", "election_district"),
    ("LD", "legislative_district"),
    ("TOWNCITY", "town_city"),
    ("WARD", "ward"),
    ("CD", "congressional_district"),
    ("SD", "senate_district"),
    ("AD", "assembly_district"),
    ("LASTVOTERDATE", "last_voted_date"),
    ("PREVYEARVOTED", "prev_year_voted"),
    ("PREVCOUNTY", "prev_county"),
    ("PREVADDRESS", "prev_address"),
    ("PREVNAME", "prev_name"),
    ("COUNTYVRNUMBER", "county_vr_number"),
    ("REGDATE", "registration_date"),
    ("VRSOURCE", "vr_source"),
    ("IDREQUIRED", "id_required"),
    ("IDMET", "id_met"),
    ("STATUS", "status"),
    ("REASONCODE", "reason_code"),
    ("INACT_DATE", "inactive_date"),
    ("PURGE_DATE", "purge_date"),
    ("SBOEID", "sboe_id"),
    ("VoterHistory", "voter_history"),
]

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


def _feed_transcoded(input_path: str, dest_path: str, encoding: str, err: dict) -> None:
    """Stream `input_path` decoded as `encoding`, re-encoded UTF-8, to `dest_path`
    (a FIFO or file). Incremental decoder so multi-byte sequences split safely
    across read boundaries; C1 control bytes dropped. Any failure stored in `err`."""
    try:
        decoder = codecs.getincrementaldecoder(encoding)()
        with open(input_path, "rb") as src, open(dest_path, "w", encoding="utf-8", newline="") as out:
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
        f"NULLIF(trim(c{i:02d}, {trim_set}), '') AS {out_name}" for i, (_, out_name) in enumerate(COLUMNS, start=1)
    )
    return f"SELECT\n    {projections}\nFROM {_read_csv_sql(stream_path)}"


def decode_txt_to_table(
    txt_path: str,
    table_fqn: str,
    conn: duckdb.DuckDBPyConnection,
    *,
    encoding: str = "latin-1",
) -> None:
    """Decode a raw NYSVOTER `.txt` into `table_fqn` on `conn`.

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
