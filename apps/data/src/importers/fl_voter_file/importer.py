"""The Florida voter-file importer.

`sources → (persons_validated, manifest)` for the Division of Elections' monthly
voter extract: the registration zip (required) and the voting-history zip
(optional). Reads each zip's county files into raw tables, joins history onto
registration in one transform to the canonical `Person` schema, and validates.
Everything below the returned `persons_validated` is the shared pipeline.
"""

from __future__ import annotations

import math
import os
from typing import TYPE_CHECKING

from src.importers.base import FilterSpec, ImportFilter, SourceSpec, check_import_inputs
from src.importers.fl_voter_file.decode import create_empty_history, read_history, read_registration
from src.importers.fl_voter_file.manifest import FL_MANIFEST
from src.importers.fl_voter_file.transform import (
    VOTES_PER_BATCH,
    VOTING_HISTORY_TYPE,
    fl_history_batch_query,
    fl_transformation_query,
    fl_votes_query,
)
from src.importers.validate import validated_persons
from src.tables import ensure_schema, table_fqn

if TYPE_CHECKING:
    from collections.abc import Mapping

    import duckdb
    from src.importers.base import Manifest, Progress
    from src.models import TableRef


class FlVoterFileImporter:
    """Curated importer for the Florida voter extract. Implements `Importer`."""

    name = "fl_voter_file"
    LABEL = "Florida Voter File"
    DESCRIPTION = "The monthly voter extract from the Florida Division of Elections."
    SOURCES = (
        SourceSpec(
            key="detail",
            label="Voter detail",
            description="URL of the .zip (YYYYMMDD_VoterDetail.zip)",
        ),
        SourceSpec(
            key="history",
            label="Voter history",
            description="URL of the .zip (YYYYMMDD_VoterHistory.zip)",
            required=False,
        ),
    )
    FILTERS = (
        FilterSpec(column="county_code", label="County"),
        FilterSpec(column="congressional_district", label="Congressional district"),
        FilterSpec(column="house_district", label="House district"),
        FilterSpec(column="senate_district", label="Senate district"),
        FilterSpec(column="residence_zipcode", label="ZIP code"),
    )
    PROGRESS_STEPS = 4  # registration, history, transform, validate

    def manifest(self) -> Manifest:
        return FL_MANIFEST

    def load(
        self,
        sources: Mapping[str, str],
        schema: str,
        conn: duckdb.DuckDBPyConnection,
        progress: Progress,
        filter: ImportFilter | None = None,
    ) -> TableRef:
        """Read the zips → transform → validate. Returns the `persons_validated`
        TableRef the shared pipeline reads from. Reports one progress step per
        stage (`PROGRESS_STEPS`)."""
        check_import_inputs(self, sources, filter)
        ensure_schema(conn, schema)
        registration_fqn = table_fqn(schema, "persons_raw")
        history_fqn = table_fqn(schema, "voting_history_raw")

        read_registration(os.path.expanduser(sources["detail"].strip()), registration_fqn, conn)
        progress.advance()

        history = os.path.expanduser(sources.get("history", "").strip())
        if history:
            read_history(history, history_fqn, conn)
        else:
            create_empty_history(history_fqn, conn)
        progress.advance()

        votes_fqn = table_fqn(schema, "voting_history_votes")
        conn.execute(f"CREATE OR REPLACE TABLE {votes_fqn} AS {fl_votes_query(registration_fqn, history_fqn, filter)}")
        grouped_fqn = table_fqn(schema, "voting_history_grouped")
        conn.execute(f"CREATE OR REPLACE TABLE {grouped_fqn} (voter_id VARCHAR, voting_history {VOTING_HISTORY_TYPE})")
        votes = conn.execute(f"SELECT count(*) FROM {votes_fqn}").fetchone()[0]
        batches = max(1, math.ceil(votes / VOTES_PER_BATCH))
        for batch in range(batches):
            conn.execute(f"INSERT INTO {grouped_fqn} {fl_history_batch_query(votes_fqn, batches, batch)}")
        query = fl_transformation_query(registration_fqn, grouped_fqn, filter)
        conn.execute(f"CREATE OR REPLACE TABLE {table_fqn(schema, 'persons_validated')} AS {query}")
        progress.advance()

        persons_validated = validated_persons(schema, conn)
        progress.advance()
        return persons_validated
