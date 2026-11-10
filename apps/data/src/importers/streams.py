"""Stream a source's bytes into a DuckDB table without staging it on disk.

A state distribution can be several GB and arrive as a URL, a zip, or a text
encoding DuckDB doesn't read. `stream_text_to_table` decodes the bytes to UTF-8
on a feeder thread and hands them to DuckDB through a FIFO, so one low-memory
`CREATE TABLE ... AS SELECT ... FROM read_csv(<fifo>)` reads the whole thing.
"""

from __future__ import annotations

import codecs
import os
import shutil
import tempfile
import threading
from typing import TYPE_CHECKING, BinaryIO

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    import duckdb

CHUNK_BYTES = 1 << 22  # 4 MiB

# C1 control characters (U+0080..U+009F) show up as stray bytes in free-form
# fields of some state exports. Never meaningful data; each maps to None to
# delete it. Accented characters live at U+00A0+ and are preserved.
C1_STRIP_TABLE = {cp: None for cp in range(0x80, 0xA0)}


def sql_str(value: str) -> str:
    """Quote a Python string as a single-quoted SQL literal."""
    return "'" + value.replace("'", "''") + "'"


def open_source(path: str) -> BinaryIO:
    """Open a source for binary reads. A bare path is a local file; a URL
    (`s3://`, `http(s)://`, …) goes through smart_open, so a multi-GB
    distribution never lands on local disk. smart_open uses boto3's credential
    chain — the same one the DuckDB S3 secret relies on. Remote handles are
    seekable, which `zipfile` needs to find a zip's directory."""
    if "://" in path:
        import smart_open

        return smart_open.open(path, "rb")
    return open(path, "rb")  # noqa: SIM115 — the caller owns the handle


def read_chunks(src: BinaryIO) -> Iterator[bytes]:
    """`src`'s bytes in `CHUNK_BYTES` pieces."""
    while chunk := src.read(CHUNK_BYTES):
        yield chunk


def _feed(chunks: Callable[[], Iterator[bytes]], dest_path: str, encoding: str, err: dict) -> None:
    """Write `chunks()` decoded as `encoding`, re-encoded UTF-8, to `dest_path`
    (a FIFO or file). Incremental decoder so multi-byte sequences split safely
    across chunks; C1 control bytes dropped. Any failure stored in `err`."""
    try:
        decoder = codecs.getincrementaldecoder(encoding)()
        with open(dest_path, "w", encoding="utf-8", newline="") as out:
            for chunk in chunks():
                out.write(decoder.decode(chunk).translate(C1_STRIP_TABLE))
            out.write(decoder.decode(b"", final=True).translate(C1_STRIP_TABLE))
    except BrokenPipeError:
        # DuckDB closed the read end early (parse error surfaces on its side).
        pass
    except BaseException as exc:  # noqa: BLE001 — report any failure to the caller
        err["exc"] = exc


def stream_text_to_table(
    chunks: Callable[[], Iterator[bytes]],
    select_sql: Callable[[str], str],
    table_fqn: str,
    conn: duckdb.DuckDBPyConnection,
    *,
    encoding: str,
) -> None:
    """`CREATE OR REPLACE TABLE table_fqn AS select_sql(path)`, where `path` is a
    UTF-8 text stream of `chunks()` decoded as `encoding`.

    Streams through a FIFO (macOS/Linux) so the text never sits on disk; falls
    back to a temp file where FIFOs aren't available. `chunks` is called once,
    on the feeder thread, so opening the source happens there too."""
    work_dir = tempfile.mkdtemp(prefix="import_stream_")
    use_fifo = hasattr(os, "mkfifo")
    stream_path = os.path.join(work_dir, "stream.utf8")
    err: dict = {}
    feeder: threading.Thread | None = None
    try:
        if use_fifo:
            os.mkfifo(stream_path)
            feeder = threading.Thread(target=_feed, args=(chunks, stream_path, encoding, err), daemon=True)
            feeder.start()
        else:
            _feed(chunks, stream_path, encoding, err)
            if "exc" in err:
                raise err["exc"]

        conn.execute(f"CREATE OR REPLACE TABLE {table_fqn} AS {select_sql(stream_path)}")

        if feeder is not None:
            feeder.join()
        if "exc" in err:
            raise err["exc"]
    finally:
        if feeder is not None and feeder.is_alive():
            feeder.join(timeout=5)
        shutil.rmtree(work_dir, ignore_errors=True)
