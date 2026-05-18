"""Load and transform a voter file into the Person schema.

Reads a state-BOE parquet dump (`voters_raw`), applies a state-specific
transformation query (`persons_transformed`), and validates the result
against the `Person` Pydantic model (`persons_validated`).

Naming reflects the split: inputs stay "voter file" (literal source),
outputs are "person" (canonical schema regardless of source).
"""

import json

import duckdb
from src.models import Person, TableRef
from src.tables import PERSON_CATALOG, ensure_org_schema, org_fqn
from src.voting_history import parse_voting_history

# Pandas NaN comes back here for SQL NULL columns, so guard before splitting.
def _parse_or_empty(raw: object) -> list[dict]:
    return parse_voting_history(raw if isinstance(raw, str) else None)

# Expected columns derived from the Person model.
_EXPECTED_COLUMNS = set(Person.model_fields.keys())


def _current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {PERSON_CATALOG}.current_snapshot()").fetchone()[0]


def voters_raw(
    voter_file_url: str,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Load raw voter data from a parquet file into DuckLake."""
    table = "voters_raw"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table)
    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    remote = conn.read_parquet(voter_file_url)
    remote.create(fqn)
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table,
        version=_current_version(conn),
    )


def persons_transformed(
    voters_raw: TableRef,
    transformation_query: str,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Apply the transformation query to the raw voter data to produce
    Person-shaped rows.

    The transformation_query should reference the raw table as ``raw``.
    """
    table = "persons_transformed"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table)
    raw = conn.table(voters_raw.fqn).set_alias("raw")
    raw.query(
        "raw",
        f"CREATE OR REPLACE TABLE {fqn} AS {transformation_query}",
    )
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table,
        version=_current_version(conn),
    )


def persons_voting_history(
    persons_transformed: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Parse the raw voting_history string out of `other_properties` and
    materialize it as a top-level `STRUCT(...)[]` column.

    Living outside the JSON column means filters on the remaining
    `other_properties` keys (enrollment, districts, dates) scan a much
    smaller payload, and voting_history itself becomes a typed column
    that downstream filters can unnest without per-row JSON parsing.
    """
    table = "persons_voting_history"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table)

    df = conn.sql(f"""
        SELECT external_id,
               json_extract_string(other_properties, '$.voting_history') AS raw_vh
        FROM {persons_transformed.fqn}
    """).df()
    df["voting_history_json"] = df["raw_vh"].map(
        lambda raw: json.dumps(_parse_or_empty(raw))
    )
    df = df[["external_id", "voting_history_json"]]

    conn.register("_parsed_voting_history_df", df)
    # json_merge_patch with a `null` value at a key removes that key (RFC 7396).
    conn.execute(f"""
        CREATE OR REPLACE TABLE {fqn} AS
        SELECT
          p.* REPLACE (
            json_merge_patch(p.other_properties, '{{"voting_history": null}}'::JSON)
              AS other_properties
          ),
          CAST(v.voting_history_json::JSON
               AS STRUCT(year INT, type VARCHAR, date VARCHAR, method VARCHAR)[]
              ) AS voting_history
        FROM {persons_transformed.fqn} p
        LEFT JOIN _parsed_voting_history_df v USING (external_id)
    """)
    conn.unregister("_parsed_voting_history_df")
    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table,
        version=_current_version(conn),
    )


def persons_validated(
    persons_voting_history: TableRef,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Validate that the persons table matches the Person schema.

    Checks that all required Person columns are present and that
    a sample of rows can be successfully parsed by the Pydantic model.
    Returns the same TableRef if validation passes; raises on failure.
    """
    rel = conn.table(persons_voting_history.fqn)
    actual_columns = set(rel.columns)

    missing = _EXPECTED_COLUMNS - actual_columns
    if missing:
        msg = f"Persons table is missing columns required by Person: {sorted(missing)}"
        raise ValueError(msg)

    extra = actual_columns - _EXPECTED_COLUMNS
    if extra:
        msg = f"Persons table has unexpected columns not in Person: {sorted(extra)}"
        raise ValueError(msg)

    # Validate a sample of rows through the Pydantic model.
    sample = rel.limit(100).fetchall()
    columns = rel.columns
    for i, row in enumerate(sample):
        row_dict = dict(zip(columns, row, strict=True))
        try:
            Person.model_validate(row_dict)
        except Exception as e:
            msg = f"Row {i} failed Person validation: {e}"
            raise ValueError(msg) from e

    return persons_voting_history
