"""Stream a persons table into an existing Quickwit index.

Assumes the target Quickwit index already exists (typically created
by a running Quickwit server upstream). Uses the Quickwit CLI's
``tool local-ingest`` command to append NDJSON batches over stdin —
disk usage stays bounded and indexing runs locally on the build
machine.
"""

from __future__ import annotations

import math
import subprocess
import tempfile
import time

import duckdb  # noqa: TC001  # Hamilton resolves annotations at runtime via typing.get_type_hints
from src.importers.base import Manifest  # noqa: TC001  # runtime annotation for Hamilton
from src.models import QuickwitBuildManifestStub, QuickwitIngestResult, TableRef
from src.quickwit import SEARCH_ONLY_FIELDS

_REQUIRED_COLUMNS = [
    "external_id",
    "external_id_type",
    "first_name",
    "last_name",
    "middle_name",
    "name_suffix",
    "address_line_1",
    "address_line_2",
    "city",
    "state",
    "zip5",
    "zip4",
]


# The Lookup list is sorted A→Z by name, but Quickwit 0.8.2 can't sort on a text
# field. So we pack the first 16 chars of the padded sort key `sk` ("LAST FIRST",
# uppercased/accent-stripped) into two big-endian u64 fast fields: each char
# becomes a byte, high char = high byte, so u64 order == lexicographic order and
# sorting by (hi, lo) is alphabetical. `least(..., 255)` guards the rare non-Latin
# codepoint from overflowing a byte.
def _packed_name_key(start: int) -> str:
    """DuckDB expr packing 8 chars of `sk` from 1-indexed `start` into a u64."""
    chars = f"[least(ascii(sk[i:i]), 255)::UBIGINT for i in range({start}, {start + 8})]"
    return f"list_reduce({chars}, (a, b) -> a * 256 + b)"


def quickwit_source_persons(
    persons_table_ref: TableRef,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Validate that the source persons table has the columns Quickwit ingest expects."""
    rel = conn.table(persons_table_ref.fqn)
    actual_columns = set(rel.columns)
    missing_columns = [column for column in _REQUIRED_COLUMNS if column not in actual_columns]
    if missing_columns:
        msg = f"Quickwit source table is missing required Person columns: {missing_columns}"
        raise ValueError(msg)
    return persons_table_ref


def quickwit_document_count(
    quickwit_source_persons: TableRef,
    conn: duckdb.DuckDBPyConnection,
) -> int:
    """Count the number of person documents that will be streamed into Quickwit."""
    return conn.table(quickwit_source_persons.fqn).aggregate("count(*)").fetchone()[0]


# Rows fetched from DuckDB and written to Quickwit at a time, so a batch never
# sits in Python whole.
_PIPE_ROWS = 10_000


def _ingest_batch(
    command: list[str],
    rows: list[tuple],
    cursor: duckdb.DuckDBPyConnection,
    batch_size: int,
    label: str,
) -> tuple[int, dict[str, float]]:
    """Pipe up to `batch_size` rows, `rows` first and then the cursor's, into one
    `local-ingest` run. Returns the rows sent and the time spent reading rows,
    writing them (Quickwit indexes as it reads, so this waits on it), and waiting
    for Quickwit to finish once its input closes. Quickwit's output goes to temp
    files rather than pipes, so it can't block on a full pipe while we write."""
    timings = {"read": 0.0, "pipe": 0.0, "finish": 0.0}
    sent = 0
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=out, stderr=err)  # noqa: S603
        assert proc.stdin is not None
        try:
            while rows:
                start = time.perf_counter()
                proc.stdin.write("".join(f"{row[0]}\n" for row in rows).encode())
                timings["pipe"] += time.perf_counter() - start
                sent += len(rows)
                start = time.perf_counter()
                rows = cursor.fetchmany(min(_PIPE_ROWS, batch_size - sent)) if sent < batch_size else []
                timings["read"] += time.perf_counter() - start
            proc.stdin.close()
        except BrokenPipeError:
            pass  # Quickwit exited early; its exit code and stderr below say why
        except BaseException:
            proc.kill()
            raise
        start = time.perf_counter()
        returncode = proc.wait()
        timings["finish"] = time.perf_counter() - start
        if returncode != 0:
            out.seek(0)
            err.seek(0)
            msg = (
                f"Quickwit local-ingest failed on batch {label}.\n"
                f"STDOUT:\n{out.read().decode(errors='replace')}\nSTDERR:\n{err.read().decode(errors='replace')}"
            )
            raise RuntimeError(msg)
    return sent, timings


def quickwit_local_ingest_result(
    quickwit_source_persons: TableRef,
    quickwit_document_count: int,
    quickwit_binary_path: str,
    quickwit_config_path: str,
    quickwit_index_id: str,
    manifest: Manifest,
    conn: duckdb.DuckDBPyConnection,
    quickwit_batch_size: int = 1_000_000,
) -> QuickwitIngestResult:
    """Stream person rows into ``quickwit tool local-ingest`` in stdin batches.

    Beyond the Person core, each `SEARCH_ONLY_FIELDS` index field carries the
    column of the manifest's field of that kind, when the dataset has one.

    Rows stream from DuckDB into each run `_PIPE_ROWS` at a time, so neither a
    batch nor the persons file is ever held whole, in memory or on disk.
    """
    if quickwit_batch_size <= 0:
        msg = "quickwit_batch_size must be greater than zero"
        raise ValueError(msg)

    source_fqn = quickwit_source_persons.fqn
    total_batches = 0 if quickwit_document_count == 0 else math.ceil(quickwit_document_count / quickwit_batch_size)

    print(
        (
            f"Starting Quickwit local-ingest for {source_fqn} into index "
            f"{quickwit_index_id}. total_docs={quickwit_document_count} "
            f"batch_size={quickwit_batch_size} total_batches={total_batches}"
        ),
        flush=True,
    )

    start_time = time.perf_counter()
    indexed_doc_count = 0
    batch_count = 0

    search_only_columns = {field: manifest.column_of_kind(field) for field in SEARCH_ONLY_FIELDS}
    search_only_entries = "".join(f"{field} := {column},\n" for field, column in search_only_columns.items() if column)
    sort_key = "rpad(substr(upper(strip_accents(concat_ws(' ', last_name, first_name))), 1, 16), 16, ' ')"
    query = f"""
        WITH prepared AS (
            SELECT *, {sort_key} AS sk FROM {source_fqn}
        )
        SELECT
            to_json(
                struct_pack(
                    external_id := external_id,
                    external_id_type := external_id_type,
                    first_name := first_name,
                    last_name := last_name,
                    middle_name := middle_name,
                    name_suffix := name_suffix,
                    address_line_1 := address_line_1,
                    address_line_2 := address_line_2,
                    city := city,
                    state := state,
                    zip5 := zip5,
                    zip4 := zip4,
                    {search_only_entries}
                    sort_key_hi := {_packed_name_key(1)},
                    sort_key_lo := {_packed_name_key(9)}
                )
            ) AS ndjson_line
        FROM prepared
        ORDER BY external_id
    """

    command = [
        quickwit_binary_path,
        "tool",
        "local-ingest",
        "--config",
        quickwit_config_path,
        "--index",
        quickwit_index_id,
        "--yes",
        "--no-color",
    ]
    cursor = conn.execute(query)
    rows = cursor.fetchmany(min(_PIPE_ROWS, quickwit_batch_size))
    while rows:
        batch_count += 1
        batch_start_doc = indexed_doc_count + 1
        batch_end_doc = min(indexed_doc_count + quickwit_batch_size, quickwit_document_count)
        print(
            (
                f"Quickwit batch {batch_count}/{total_batches}: "
                f"docs {batch_start_doc}-{batch_end_doc} of {quickwit_document_count}"
            ),
            flush=True,
        )
        batch_start = time.perf_counter()
        sent, timings = _ingest_batch(command, rows, cursor, quickwit_batch_size, f"{batch_count}/{total_batches}")
        indexed_doc_count += sent
        rows = cursor.fetchmany(min(_PIPE_ROWS, quickwit_batch_size))
        print(
            (
                f"Finished Quickwit batch {batch_count}/{total_batches} in {time.perf_counter() - batch_start:.2f}s "
                f"(reading rows {timings['read']:.1f}s, piping {timings['pipe']:.1f}s, "
                f"Quickwit finishing {timings['finish']:.1f}s). "
                f"indexed_so_far={indexed_doc_count}/{quickwit_document_count}"
            ),
            flush=True,
        )

    elapsed_seconds = time.perf_counter() - start_time
    print(
        (
            f"Completed Quickwit local-ingest for index {quickwit_index_id}. "
            f"indexed_docs={indexed_doc_count} batches={batch_count} elapsed={elapsed_seconds:.2f}s"
        ),
        flush=True,
    )

    return QuickwitIngestResult(
        index_id=quickwit_index_id,
        source_table_fqn=source_fqn,
        source_table_version=quickwit_source_persons.version,
        indexed_doc_count=indexed_doc_count,
        batch_count=batch_count,
        elapsed_seconds=elapsed_seconds,
    )


def quickwit_build_manifest_stub(
    quickwit_local_ingest_result: QuickwitIngestResult,
) -> QuickwitBuildManifestStub:
    """Return a placeholder manifest payload for the future manifest writer."""
    return QuickwitBuildManifestStub(
        index_id=quickwit_local_ingest_result.index_id,
        source_table_fqn=quickwit_local_ingest_result.source_table_fqn,
        source_table_version=quickwit_local_ingest_result.source_table_version,
        indexed_doc_count=quickwit_local_ingest_result.indexed_doc_count,
        batch_count=quickwit_local_ingest_result.batch_count,
        elapsed_seconds=quickwit_local_ingest_result.elapsed_seconds,
    )
