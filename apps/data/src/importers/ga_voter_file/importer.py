"""The Georgia voter-list importer.

`sources → (persons_validated, manifest)` for the Secretary of State's ordered
voter list CSV (required) and optional free voter-history CSVs from
mvp.sos.ga.gov. Reads registration into `persons_raw`, history into
`voting_history_raw`, joins them in one transform to the canonical `Person`
schema, and validates. Everything below the returned `persons_validated` is
the shared pipeline.
"""

from __future__ import annotations

import math
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
from src.importers.ga_voter_file.decode import (
    create_empty_history,
    history_source_format,
    load_tabular_to_table,
    read_history,
    source_format,
)
from src.importers.ga_voter_file.manifest import GA_MANIFEST
from src.importers.ga_voter_file.transform import (
    VOTES_PER_BATCH,
    VOTING_HISTORY_TYPE,
    ga_history_batch_query,
    ga_transformation_query,
    ga_votes_query,
)
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
        SourceSpec(
            key="history",
            label="Voter history",
            description="Upload or URL of a mvp.sos.ga.gov .csv or a .zip of them",
            required=False,
        ),
    )
    FILTERS = (
        FilterSpec(column="county", label="County"),
        FilterSpec(column="congressional_district", label="Congressional district"),
        FilterSpec(column="state_senate_district", label="Senate district"),
        FilterSpec(column="state_house_district", label="House district"),
        FilterSpec(column="residence_zipcode", label="ZIP code"),
    )
    PROGRESS_STEPS = 4  # decode, history, transform, validate

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
        """Read the voter list (+ optional history) → transform → validate."""
        check_import_inputs(self, sources, filter)
        ensure_schema(conn, schema)
        source = os.path.expanduser(sources["file"].strip())
        fmt = source_format(source)
        if fmt is None:
            raise SourceUnreadableError(f"{redact_source(source)!r} must be a .csv or .parquet Georgia voter list.")

        registration_fqn = table_fqn(schema, "persons_raw")
        history_fqn = table_fqn(schema, "voting_history_raw")

        load_tabular_to_table(source, fmt, registration_fqn, conn)
        progress.advance()

        history = os.path.expanduser(sources.get("history", "").strip())
        if history:
            history_fmt = history_source_format(history)
            if history_fmt is None:
                raise SourceUnreadableError(
                    f"{redact_source(history)!r} must be a .csv voter-history file or a .zip of them."
                )
            read_history(history, history_fmt, history_fqn, conn)
        else:
            create_empty_history(history_fqn, conn)
        progress.advance()

        votes_fqn = table_fqn(schema, "voting_history_votes")
        conn.execute(f"CREATE OR REPLACE TABLE {votes_fqn} AS {ga_votes_query(registration_fqn, history_fqn, filter)}")
        grouped_fqn = table_fqn(schema, "voting_history_grouped")
        conn.execute(f"CREATE OR REPLACE TABLE {grouped_fqn} (voter_id VARCHAR, voting_history {VOTING_HISTORY_TYPE})")
        votes = conn.execute(f"SELECT count(*) FROM {votes_fqn}").fetchone()[0]
        batches = max(1, math.ceil(votes / VOTES_PER_BATCH))
        for batch in range(batches):
            conn.execute(f"INSERT INTO {grouped_fqn} {ga_history_batch_query(votes_fqn, batches, batch)}")

        query = ga_transformation_query(registration_fqn, grouped_fqn, filter)
        conn.execute(f"CREATE OR REPLACE TABLE {table_fqn(schema, 'persons_validated')} AS {query}")
        progress.advance()

        persons_validated = validated_persons(schema, conn)
        progress.advance()
        return persons_validated
