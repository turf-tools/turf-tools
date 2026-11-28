"""Read import sources (local paths, links, zips) and stream their bytes into a
DuckDB table without staging them on disk.

A state distribution can be several GB and arrive as a URL, a zip, or a text
encoding DuckDB doesn't read. `stream_text_to_table` decodes the bytes to UTF-8
on a feeder thread and hands them to DuckDB through a FIFO, so one low-memory
`CREATE TABLE ... AS SELECT ... FROM read_csv(<fifo>)` reads the whole thing.
Zip members are found by name, skipping macOS Finder metadata, and streamed one
after another (`zip_chunks`) or one at a time (`zip_member_chunks`).
"""

from __future__ import annotations

import codecs
import os
import shutil
import tempfile
import threading
import zipfile
from pathlib import PurePosixPath
from typing import TYPE_CHECKING, BinaryIO
from urllib.parse import urlsplit

from src.importers.base import SourceUnreadableError, redact_source

if TYPE_CHECKING:
    import re
    from collections.abc import Callable, Iterator

    import duckdb

CHUNK_BYTES = 1 << 22  # 4 MiB

# Trimmed from every field. Space is the usual padding; tabs and bare CR/LF
# survive in malformed exports.
TRIM_CHARS = " \t\r\n"

# C1 control characters (U+0080..U+009F) show up as stray bytes in free-form
# fields of some state exports. Never meaningful data; each maps to None to
# delete it. Accented characters live at U+00A0+ and are preserved.
C1_STRIP_TABLE = {cp: None for cp in range(0x80, 0xA0)}


def sql_str(value: str) -> str:
    """Quote a Python string as a single-quoted SQL literal."""
    return "'" + value.replace("'", "''") + "'"


def open_source(path: str) -> BinaryIO:
    """Open a source for binary reads: a local path, or an http(s) link (the
    only URLs `check_import_inputs` admits) streamed through smart_open, so a
    multi-GB distribution never lands on local disk. Remote handles are
    seekable, which `zipfile` needs to find a zip's directory."""
    if "://" in path:
        import smart_open

        return smart_open.open(path, "rb")
    return open(path, "rb")  # noqa: SIM115 — the caller owns the handle


def source_extension(source: str) -> str:
    """The source's lowercased extension (`.csv`), read off the URL path so a
    presigned query string doesn't hide it."""
    return PurePosixPath(urlsplit(source).path).suffix.lower()


def check_source_exists(source: str) -> None:
    """Fail with a readable message when a local path doesn't exist. A link
    can't be checked up front; it fails where it's read."""
    if "://" not in source and not os.path.exists(source):
        raise SourceUnreadableError(f"Import source not found: {redact_source(source)!r}")


def source_chunks(source: str) -> Iterator[bytes]:
    """The source's bytes in `CHUNK_BYTES` pieces."""
    with open_source(source) as src:
        yield from read_chunks(src)


def first_line(source: str, member: str | None = None) -> bytes:
    """The first line of `source`, or of the zip member named `member` in it."""
    with open_source(source) as src:
        if member is None:
            return src.readline()
        with zipfile.ZipFile(src) as zf, zf.open(member) as m:
            return m.readline()


def is_zip_payload_member(info: zipfile.ZipInfo) -> bool:
    """True for real file members — skips directories and macOS Finder junk.

    Finder "Compress" adds `__MACOSX/._*` AppleDouble forks that often share
    the payload's extension but aren't text/shapefile data readers can use.
    """
    if info.is_dir():
        return False
    parts = info.filename.replace("\\", "/").split("/")
    base = parts[-1]
    if any(p == "__MACOSX" or p.startswith("._") for p in parts):
        return False
    return not base.startswith(".")


def zip_members(zf: zipfile.ZipFile, pattern: re.Pattern[str]) -> list[zipfile.ZipInfo]:
    """The zip's payload files whose base name matches `pattern`, in name order."""
    found = [i for i in zf.infolist() if is_zip_payload_member(i) and pattern.match(i.filename.rsplit("/", 1)[-1])]
    return sorted(found, key=lambda i: i.filename)


def check_zip(source: str, pattern: re.Pattern[str], expected: str) -> list[str]:
    """The names of `source`'s members matching `pattern`. Fails with a readable
    message unless `source` is a zip holding at least one (`expected` names
    them, e.g. "voting history (CNT_H_YYYYMMDD.txt)")."""
    check_source_exists(source)
    try:
        with open_source(source) as raw, zipfile.ZipFile(raw) as zf:
            names = [i.filename for i in zip_members(zf, pattern)]
    except (OSError, zipfile.BadZipFile) as exc:
        raise SourceUnreadableError(
            f"Could not read {redact_source(source)!r} as a zip. Check that it exists and is reachable."
        ) from exc
    if not names:
        raise SourceUnreadableError(f"{redact_source(source)!r} has no {expected} files in it.")
    return names


def _member_chunks(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> Iterator[bytes]:
    """One member's bytes, ending in a newline."""
    last = b"\n"
    with zf.open(info) as member:
        for chunk in read_chunks(member):
            last = chunk[-1:]
            yield chunk
    if last != b"\n":
        yield b"\r\n"


def zip_chunks(source: str, pattern: re.Pattern[str]) -> Iterator[bytes]:
    """Every member matching `pattern`, back to back, each ending in a newline."""
    with open_source(source) as raw, zipfile.ZipFile(raw) as zf:
        for info in zip_members(zf, pattern):
            yield from _member_chunks(zf, info)


def zip_member_chunks(source: str, member: str) -> Iterator[bytes]:
    """The bytes of the member named `member`, ending in a newline."""
    with open_source(source) as raw, zipfile.ZipFile(raw) as zf:
        yield from _member_chunks(zf, zf.getinfo(member))


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
    append: bool = False,
) -> None:
    """`CREATE OR REPLACE TABLE table_fqn AS select_sql(path)`, where `path` is a
    UTF-8 text stream of `chunks()` decoded as `encoding`; with `append`,
    `INSERT INTO table_fqn select_sql(path)`.

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

        statement = f"INSERT INTO {table_fqn}" if append else f"CREATE OR REPLACE TABLE {table_fqn} AS"
        conn.execute(f"{statement} {select_sql(stream_path)}")

        if feeder is not None:
            feeder.join()
        if "exc" in err:
            raise err["exc"]
    finally:
        if feeder is not None and feeder.is_alive():
            feeder.join(timeout=5)
        shutil.rmtree(work_dir, ignore_errors=True)
