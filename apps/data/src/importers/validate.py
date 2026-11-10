"""The check every importer runs on its `persons_validated` before handing it on."""

from __future__ import annotations

from typing import TYPE_CHECKING

from src.models import Person, TableRef
from src.tables import PERSON_CATALOG, table_fqn

if TYPE_CHECKING:
    import duckdb

_EXPECTED_COLUMNS = set(Person.model_fields.keys())


def validated_persons(schema: str, conn: duckdb.DuckDBPyConnection) -> TableRef:
    """Check `<schema>.persons_validated` carries the Person-required columns and
    that a sample of rows validates, then return its TableRef for the shared
    pipeline."""
    fqn = table_fqn(schema, "persons_validated")
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
    version = conn.sql(f"FROM {PERSON_CATALOG}.current_snapshot()").fetchone()[0]
    return TableRef(catalog=PERSON_CATALOG, schema=schema, table="persons_validated", version=version)
