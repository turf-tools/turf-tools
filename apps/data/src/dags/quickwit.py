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
import time

import duckdb  # noqa: TC001  # Hamilton resolves annotations at runtime via typing.get_type_hints
from src.models import QuickwitBuildManifestStub, QuickwitIngestResult, TableRef

_REQUIRED_COLUMNS = [
    "external_id",
    "external_id_type",
    "first_name",
    "last_name",
    "address_line_1",
    "address_line_2",
    "city",
    "state",
    "zip5",
    "zip4",
]


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


def quickwit_local_ingest_result(
    quickwit_source_persons: TableRef,
    quickwit_document_count: int,
    quickwit_binary_path: str,
    quickwit_config_path: str,
    quickwit_index_id: str,
    conn: duckdb.DuckDBPyConnection,
    quickwit_batch_size: int = 1_000_000,
) -> QuickwitIngestResult:
    """Stream person rows into ``quickwit tool local-ingest`` in stdin batches.

    The source table is read from DuckLake and serialized to NDJSON entirely in
    memory, one batch at a time, so the build machine never needs a full copy
    of the persons file as a temporary NDJSON file on disk.
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

    query = f"""
        SELECT
            to_json(
                struct_pack(
                    external_id := external_id,
                    external_id_type := external_id_type,
                    first_name := first_name,
                    last_name := last_name,
                    address_line_1 := address_line_1,
                    address_line_2 := address_line_2,
                    city := city,
                    state := state,
                    zip5 := zip5,
                    zip4 := zip4
                )
            ) AS ndjson_line
        FROM {source_fqn}
        ORDER BY external_id
    """

    cursor = conn.execute(query)
    while True:
        rows = cursor.fetchmany(quickwit_batch_size)
        if not rows:
            break

        batch_count += 1
        batch_start_doc = indexed_doc_count + 1
        batch_end_doc = indexed_doc_count + len(rows)
        print(
            (
                f"Quickwit batch {batch_count}/{total_batches}: "
                f"docs {batch_start_doc}-{batch_end_doc} of {quickwit_document_count}"
            ),
            flush=True,
        )

        ndjson_lines = [row[0] for row in rows]

        batch_start = time.perf_counter()
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
        result = subprocess.run(  # noqa: S603
            command,
            input="\n".join(ndjson_lines) + "\n",
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            msg = (
                f"Quickwit local-ingest failed on batch {batch_count}/{total_batches}.\n"
                f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
            )
            raise RuntimeError(msg)

        batch_elapsed = time.perf_counter() - batch_start
        indexed_doc_count += len(rows)
        print(
            (
                f"Finished Quickwit batch {batch_count}/{total_batches} in {batch_elapsed:.2f}s. "
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
