"""The Georgia voter-list importer.

`sources → (persons_validated, manifest)` for the Secretary of State's ordered
voter list CSV (county extracts and the statewide file share one layout). Reads
the file into `persons_raw`, transforms to the canonical `Person` schema, and
validates. Everything below the returned `persons_validated` is the shared
pipeline.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from src.importers.base import (
    FilterSpec,
    ImportFilter,
    SourceSpec,
    SourceUnreadableError,
    check_import_inputs,
    redact_source,
)
from src.importers.ga_voter_file.decode import load_tabular_to_table, source_format
from src.importers.ga_voter_file.manifest import GA_MANIFEST
from src.importers.ga_voter_file.transform import ga_transformation_query
from src.importers.validate import validated_persons
from src.tables import ensure_schema, table_fqn

if TYPE_CHECKING:
    from collections.abc import Mapping

    import duckdb
    from src.importers.base import Manifest, Progress
    from src.models import TableRef


class GaVoterFileImporter:
    """Curated importer for the Georgia SOS voter list. Implements `Importer`."""

    name = "ga_voter_file"
    LABEL = "Georgia Voter File"
    SOURCES = (
        SourceSpec(
            key="file",
            label="Voter file",
            description="URL of a .csv or .parquet file",
        ),
    )
    FILTERS = (
        FilterSpec(column="county", label="County"),
        FilterSpec(column="congressional_district", label="Congressional district"),
        FilterSpec(column="state_senate_district", label="Senate district"),
        FilterSpec(column="state_house_district", label="House district"),
        FilterSpec(column="residence_zipcode", label="ZIP code"),
    )
    PROGRESS_STEPS = 3  # decode, transform, validate

    def manifest(self) -> Manifest:
        return GA_MANIFEST

    def load(
        self,
        sources: Mapping[str, str],
        schema: str,
        conn: duckdb.DuckDBPyConnection,
        progress: Progress,
        filter: ImportFilter | None = None,
    ) -> TableRef:
        """Read the voter list → transform → validate."""
        check_import_inputs(self, sources, filter)
        ensure_schema(conn, schema)
        source = os.path.expanduser(sources["file"].strip())
        fmt = source_format(source)
        if fmt is None:
            raise SourceUnreadableError(f"{redact_source(source)!r} must be a .csv or .parquet Georgia voter list.")

        registration_fqn = table_fqn(schema, "persons_raw")
        load_tabular_to_table(source, fmt, registration_fqn, conn)
        progress.advance()

        query = ga_transformation_query(registration_fqn, filter)
        conn.execute(f"CREATE OR REPLACE TABLE {table_fqn(schema, 'persons_validated')} AS {query}")
        progress.advance()

        persons_validated = validated_persons(schema, conn)
        progress.advance()
        return persons_validated
