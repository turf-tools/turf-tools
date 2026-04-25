"""Hamilton graph for loading and transforming voter files into DuckLake.

The input is a literal voter file (parquet dump from a state BOE). The output
is `{organization_slug}_persons` — Person-shaped rows that downstream DAGs
consume. Naming reflects that split: inputs stay "voter file", outputs are
"persons".
"""

import duckdb

from src.models import Person, TableRef

CATALOG = "ducklake"
SCHEMA = "main"

# Expected columns derived from the Person model.
_EXPECTED_COLUMNS = set(Person.model_fields.keys())


def raw_voter_data(
    voter_file_url: str,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Load raw voter data from a parquet file into DuckLake."""
    table_name = f"{organization_slug}_voters_raw"
    fqn = f"{CATALOG}.{SCHEMA}.{table_name}"
    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    remote = conn.read_parquet(voter_file_url)
    remote.create(fqn)
    version = conn.sql(f"FROM {CATALOG}.current_snapshot()").fetchone()[0]
    return TableRef(
        catalog=CATALOG, schema=SCHEMA, table=table_name, version=version
    )


def transformed_persons(
    raw_voter_data: TableRef,
    transformation_query: str,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Apply the transformation query to the raw voter data to produce
    Person-shaped rows.

    The transformation_query should reference the raw table as ``raw``.
    """
    table_name = f"{organization_slug}_persons"
    raw = conn.table(raw_voter_data.fqn).set_alias("raw")
    raw.query(
        "raw",
        f"CREATE OR REPLACE TABLE {CATALOG}.{SCHEMA}.{table_name} AS {transformation_query}",
    )
    version = conn.sql(f"FROM {CATALOG}.current_snapshot()").fetchone()[0]
    return TableRef(
        catalog=CATALOG, schema=SCHEMA, table=table_name, version=version
    )


def validated_persons(
    transformed_persons: TableRef,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Validate that the persons table matches the Person schema.

    Checks that all required Person columns are present and that
    a sample of rows can be successfully parsed by the Pydantic model.
    Returns the same TableRef if validation passes; raises on failure.
    """
    rel = conn.table(transformed_persons.fqn)
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
        row_dict = dict(zip(columns, row))
        try:
            Person.model_validate(row_dict)
        except Exception as e:
            msg = f"Row {i} failed Person validation: {e}"
            raise ValueError(msg) from e

    return transformed_persons
