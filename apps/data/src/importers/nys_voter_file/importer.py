"""The NYS voter-file importer.

`source → (persons_validated, manifest)` for the New York State statewide voter
file. Owns the full front of the pipeline: decode the raw fixed-width `.txt`
distribution (or read an already-decoded parquet/CSV), transform to the canonical
`Person` schema, parse the voting-history string into a `STRUCT[]`, and validate.
Everything below the returned `persons_validated` (geocode → assembly → aggregate)
is the shared, source-agnostic pipeline.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from src.importers.nys_voter_file.decode import decode_txt_to_table
from src.importers.nys_voter_file.manifest import NYS_MANIFEST
from src.importers.nys_voter_file.transform import nys_sboe_transformation_query
from src.importers.nys_voter_file.voting_history import parse_voting_history
from src.models import Person, TableRef
from src.tables import PERSON_CATALOG, ensure_schema, table_fqn

if TYPE_CHECKING:
    import duckdb
    from src.importers.base import Manifest

_EXPECTED_COLUMNS = set(Person.model_fields.keys())


def _current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {PERSON_CATALOG}.current_snapshot()").fetchone()[0]


def _parse_or_empty(raw: object) -> list[dict]:
    # Pandas returns NaN (a float) for SQL NULL; guard before parsing.
    return parse_voting_history(raw if isinstance(raw, str) else None)


class NysVoterFileImporter:
    """Curated importer for the NYS statewide voter file. Implements `Importer`.

    NYS-specific scoping (county filter, dev ZIP5 slice) is instance config so
    `load` stays source-agnostic.
    """

    name = "nys_voter_file"

    def __init__(
        self,
        *,
        county_codes: list[str] | None = None,
        zip5_filter: list[str] | None = None,
    ) -> None:
        self._county_codes = county_codes
        self._zip5_filter = zip5_filter

    def manifest(self) -> Manifest:
        return NYS_MANIFEST

    def load(
        self,
        source: str,
        schema: str,
        conn: duckdb.DuckDBPyConnection,
    ) -> TableRef:
        """Decode/read `source` → transform → parse voting history → validate.
        Returns the `persons_validated` TableRef the shared pipeline reads from."""
        ensure_schema(conn, schema)
        raw_fqn = table_fqn(schema, "persons_raw")
        transformed_fqn = table_fqn(schema, "persons_transformed")
        validated_fqn = table_fqn(schema, "persons_validated")

        # 1. Source → persons_raw. Raw `.txt` gets the fixed-width decode; an
        #    already-tabular parquet/CSV loads directly.
        if source.lower().endswith(".txt"):
            decode_txt_to_table(source, raw_fqn, conn)
        else:
            conn.execute(f"DROP TABLE IF EXISTS {raw_fqn}")
            conn.read_parquet(source).create(raw_fqn)

        # 2. Transform to the canonical Person schema (raw NYS codes → canonical
        #    labels, address assembly, etc.). `voter_history` rides through as a
        #    transient raw column for step 3.
        query = nys_sboe_transformation_query(
            source_table=raw_fqn,
            county_codes=self._county_codes,
            zip5_filter=self._zip5_filter,
        )
        conn.execute(f"CREATE OR REPLACE TABLE {transformed_fqn} AS {query}")

        # 3. Parse the raw voter_history string → typed STRUCT[]; drop the
        #    transient column. Producing the final validated table.
        df = conn.sql(f"SELECT external_id, voter_history AS raw_vh FROM {transformed_fqn}").df()
        df["voting_history_json"] = df["raw_vh"].map(lambda raw: json.dumps(_parse_or_empty(raw)))
        df = df[["external_id", "voting_history_json"]]
        conn.register("_parsed_voting_history_df", df)
        conn.execute(f"""
            CREATE OR REPLACE TABLE {validated_fqn} AS
            SELECT
              p.* EXCLUDE (voter_history),
              CAST(v.voting_history_json::JSON
                   AS STRUCT(year INT, type VARCHAR, date VARCHAR, method VARCHAR)[]
                  ) AS voting_history
            FROM {transformed_fqn} p
            LEFT JOIN _parsed_voting_history_df v USING (external_id)
        """)
        conn.unregister("_parsed_voting_history_df")

        # 4. Validate the result carries the Person-required columns + a sample of
        #    rows through the model. Extra (manifest) columns are allowed.
        self._validate(validated_fqn, conn)

        return TableRef(
            catalog=PERSON_CATALOG,
            schema=schema,
            table="persons_validated",
            version=_current_version(conn),
        )

    @staticmethod
    def _validate(fqn: str, conn: duckdb.DuckDBPyConnection) -> None:
        rel = conn.table(fqn)
        # Required-subset, not exact-match: `persons_validated` must contain the
        # Person core, but also carries the dataset's extra filterable columns
        # (described by the manifest), which are legitimately present.
        missing = _EXPECTED_COLUMNS - set(rel.columns)
        if missing:
            raise ValueError(f"persons_validated missing columns required by Person: {sorted(missing)}")
        columns = rel.columns
        for i, row in enumerate(rel.limit(100).fetchall()):
            try:
                # Person ignores the extra columns; only the required core is validated.
                Person.model_validate(dict(zip(columns, row, strict=True)))
            except Exception as e:
                raise ValueError(f"Row {i} failed Person validation: {e}") from e
