"""The NYS voter-file importer.

`source → (persons_validated, manifest)` for the New York State statewide voter
file. Owns the full front of the pipeline: decode the raw headerless layout
(`.txt`, or a `.csv` without a header), or read a CSV-with-header / parquet whose
columns carry the layout's field names, then transform to the canonical
`Person` schema, parse the voting-history string into a `STRUCT[]`, and validate.
Everything below the returned `persons_validated` (geocode → assembly → aggregate)
is the shared, source-agnostic pipeline.
"""

from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING

import duckdb
from src.importers.base import (
    FilterSpec,
    ImportFilter,
    SourceSpec,
    SourceUnreadableError,
    check_import_inputs,
    redact_source,
)
from src.importers.nys_voter_file.decode import (
    csv_has_header,
    decode_raw_to_table,
    load_tabular_to_table,
    source_format,
)
from src.importers.nys_voter_file.manifest import NYS_MANIFEST
from src.importers.nys_voter_file.transform import nys_sboe_transformation_query
from src.importers.nys_voter_file.voting_history import parse_voting_history
from src.importers.validate import validated_persons
from src.tables import ensure_schema, table_fqn

if TYPE_CHECKING:
    from collections.abc import Mapping

    from src.importers.base import Manifest, Progress
    from src.models import TableRef


def _voting_history_json(raw: str | None) -> str:
    """Scalar-UDF body: one raw VoterHistory blob → JSON array of entries."""
    return json.dumps(parse_voting_history(raw))


def register_voting_history_udf(conn: duckdb.DuckDBPyConnection) -> None:
    """Register `parse_voting_history_json` on `conn`. Pair with
    `conn.remove_function` — the connection may outlive the load."""
    # Type names as strings: `duckdb.typing` was removed in duckdb 1.5.
    conn.create_function(
        "parse_voting_history_json",
        _voting_history_json,
        ["VARCHAR"],
        "VARCHAR",
        # NULL input reaches the UDF (→ `[]`) instead of short-circuiting to a
        # NULL voting_history.
        null_handling="special",
    )


class NysVoterFileImporter:
    """Curated importer for the NYS statewide voter file. Implements `Importer`."""

    name = "nys_voter_file"
    LABEL = "New York State Voter File"
    DESCRIPTION = "The statewide voter file from the New York State Board of Elections."
    SOURCES = (
        SourceSpec(
            key="file",
            label="Voter file",
            description="URL of a .txt, .csv, or .parquet file",
        ),
    )
    # Geographic slices worth fixing a dataset to. Election district is left
    # out: it's only unique within a county.
    FILTERS = (
        FilterSpec(column="cd", label="Congressional district"),
        FilterSpec(column="ad", label="Assembly district"),
        FilterSpec(column="sd", label="Senate district"),
        FilterSpec(column="countycode", label="County"),
        FilterSpec(column="rzip5", label="ZIP code"),
    )
    PROGRESS_STEPS = 3  # decode, transform, parse+validate

    def manifest(self) -> Manifest:
        return NYS_MANIFEST

    def load(
        self,
        sources: Mapping[str, str],
        schema: str,
        conn: duckdb.DuckDBPyConnection,
        progress: Progress,
        filter: ImportFilter | None = None,
    ) -> TableRef:
        """Decode/read the voter file → transform → parse voting history → validate.
        Returns the `persons_validated` TableRef the shared pipeline reads from.
        Reports one progress step per stage (`PROGRESS_STEPS`)."""
        check_import_inputs(self, sources, filter)
        source = sources["file"].strip()
        fmt = source_format(source)
        if fmt is None:
            raise SourceUnreadableError(
                f"Unsupported file type for {redact_source(source)!r}: expected .txt, .csv, or .parquet."
            )
        # Expand `~` and verify a local source exists up front, so a missing
        # path fails with a clear message before any schema work. (`://` =
        # object-storage key.)
        source = os.path.expanduser(source)
        if "://" not in source and not os.path.exists(source):
            raise SourceUnreadableError(f"Import source not found: {redact_source(source)!r}")
        ensure_schema(conn, schema)
        raw_fqn = table_fqn(schema, "persons_raw")
        transformed_fqn = table_fqn(schema, "persons_transformed")
        validated_fqn = table_fqn(schema, "persons_validated")

        # 1. Source → persons_raw. The headerless layout gets the raw decode; a
        #    CSV-with-header or parquet is mapped by column name.
        #    A remote source can't be checked up front the way a local path can,
        #    so this is where a bad URL surfaces.
        try:
            if fmt == "txt" or (fmt == "csv" and not csv_has_header(source)):
                decode_raw_to_table(source, raw_fqn, conn)
            else:
                load_tabular_to_table(source, fmt, raw_fqn, conn)
        except (duckdb.Error, OSError) as exc:
            raise SourceUnreadableError(
                f"Could not read the import source {redact_source(source)!r}. Check that it exists and is reachable."
            ) from exc
        progress.advance()

        # 2. Transform to the canonical Person schema (raw NYS codes → canonical
        #    labels, address assembly, etc.). `voter_history` rides through as a
        #    transient raw column for step 3.
        query = nys_sboe_transformation_query(source_table=raw_fqn, filter=filter)
        conn.execute(f"CREATE OR REPLACE TABLE {transformed_fqn} AS {query}")
        progress.advance()

        # 3. Parse the raw voter_history string → typed STRUCT[]; drop the
        #    transient column. The parser runs as a scalar UDF so DuckDB streams
        #    rows through it in batches — the full column never sits in Python.
        register_voting_history_udf(conn)
        try:
            conn.execute(f"""
                CREATE OR REPLACE TABLE {validated_fqn} AS
                SELECT
                  * EXCLUDE (voter_history),
                  CAST(parse_voting_history_json(voter_history)::JSON
                       AS STRUCT(year INT, type VARCHAR, date VARCHAR, method VARCHAR)[]
                      ) AS voting_history
                FROM {transformed_fqn}
            """)
        finally:
            # The connection outlives this load (the pipeline reuses it); leave no name behind.
            conn.remove_function("parse_voting_history_json")

        # 4. Validate the result carries the Person-required columns + a sample of
        #    rows through the model. Extra (manifest) columns are allowed.
        persons_validated = validated_persons(schema, conn)
        progress.advance()
        return persons_validated
