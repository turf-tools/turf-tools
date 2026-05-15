"""Hamilton graph for loading and transforming voter files into DuckLake.

The input is a literal voter file (parquet dump from a state BOE). The output
is `persons_transformed` (in the org's schema) — Person-shaped rows that
downstream DAGs consume. Naming reflects that split: inputs stay "voter
file", outputs are "person".
"""

import duckdb
from src.models import Person, TableRef
from src.tables import PERSON_CATALOG, ensure_org_schema, org_fqn

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


def persons_validated(
    persons_transformed: TableRef,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """Validate that the persons table matches the Person schema.

    Checks that all required Person columns are present and that
    a sample of rows can be successfully parsed by the Pydantic model.
    Returns the same TableRef if validation passes; raises on failure.
    """
    rel = conn.table(persons_transformed.fqn)
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

    return persons_transformed
