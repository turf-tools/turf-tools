"""The Georgia voter-list importer.

`sources → (persons_validated, manifest)` for the Secretary of State's ordered
voter list (required) and the per-election voter-history CSVs from
mvp.sos.ga.gov (optional). Reads the voter list into `persons_raw` and history
into `voting_history_raw`, joins them in one transform to the canonical
`Person` schema, and validates. Everything below the returned
`persons_validated` is the shared pipeline.
"""

from __future__ import annotations

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
from src.importers.carry import carry_forward
from src.importers.ga_voter_file.decode import GA_LAYOUT, create_empty_history, read_history, source_format
from src.importers.ga_voter_file.manifest import GA_MANIFEST
from src.importers.ga_voter_file.transform import (
    FILTER_EXPRESSIONS,
    ga_last_party_query,
    ga_transformation_query,
    ga_votes_query,
)
from src.importers.history import group_votes
from src.importers.sql import filter_predicate
from src.importers.streams import check_source_exists
from src.importers.tabular import load_tabular_to_table
from src.importers.validate import validated_persons
from src.tables import ensure_schema, table_fqn

if TYPE_CHECKING:
    from collections.abc import Mapping

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
            on_update="keep",
            table="persons_raw",
        ),
        SourceSpec(
            key="history",
            label="Voter history",
            description="URL of a .csv or .zip file",
            required=False,
            on_update="add",
            table="voting_history_raw",
        ),
    )
    FILTERS = (
        FilterSpec(column="county", label="County"),
        FilterSpec(column="municipality", label="Municipality"),
        FilterSpec(column="congressional_district", label="Congressional district"),
        FilterSpec(column="state_senate_district", label="Senate district"),
        FilterSpec(column="state_house_district", label="House district"),
        FilterSpec(column="residence_zipcode", label="ZIP code"),
    )
    PROGRESS_STEPS = 4  # voter list, history, transform, validate

    def manifest(self) -> Manifest:
        return GA_MANIFEST

    def load(
        self,
        sources: Mapping[str, str],
        schema: str,
        conn: duckdb.DuckDBPyConnection,
        progress: Progress,
        filter: ImportFilter | None = None,
        base_schema: str | None = None,
    ) -> TableRef:
        """Read the voter list (+ optional history), add what the base version
        carries forward → transform → validate."""
        check_import_inputs(self, sources, filter, update=base_schema is not None)
        ensure_schema(conn, schema)
        registration_fqn = table_fqn(schema, "persons_raw")
        history_fqn = table_fqn(schema, "voting_history_raw")

        source = os.path.expanduser(sources.get("file", "").strip())
        if source:
            _read_voter_list(source, registration_fqn, conn)
        progress.advance()

        history = os.path.expanduser(sources.get("history", "").strip())
        if history:
            read_history(history, history_fqn, conn)
        else:
            create_empty_history(history_fqn, conn)
        carry_forward(self, sources, schema, base_schema, conn, filter_predicate(filter, FILTER_EXPRESSIONS))
        progress.advance()

        votes_fqn = table_fqn(schema, "voting_history_votes")
        conn.execute(f"CREATE OR REPLACE TABLE {votes_fqn} AS {ga_votes_query(registration_fqn, history_fqn, filter)}")
        grouped_fqn = table_fqn(schema, "voting_history_grouped")
        group_votes(votes_fqn, grouped_fqn, conn)
        party_fqn = table_fqn(schema, "voting_history_party")
        conn.execute(
            f"CREATE OR REPLACE TABLE {party_fqn} AS {ga_last_party_query(registration_fqn, history_fqn, filter)}"
        )
        query = ga_transformation_query(registration_fqn, grouped_fqn, party_fqn, filter)
        conn.execute(f"CREATE OR REPLACE TABLE {table_fqn(schema, 'persons_validated')} AS {query}")
        progress.advance()

        persons_validated = validated_persons(schema, conn)
        progress.advance()
        return persons_validated


def _read_voter_list(source: str, table_fqn: str, conn: duckdb.DuckDBPyConnection) -> None:
    fmt = source_format(source)
    if fmt is None:
        raise SourceUnreadableError(f"{redact_source(source)!r} must be a .csv or .parquet Georgia voter list.")
    check_source_exists(source)
    try:
        load_tabular_to_table(source, fmt, table_fqn, conn, GA_LAYOUT)
    except (duckdb.Error, OSError) as exc:
        raise SourceUnreadableError(
            f"Could not read the import source {redact_source(source)!r}. Check that it exists and is reachable."
        ) from exc
