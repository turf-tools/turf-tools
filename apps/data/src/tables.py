"""Dataset-version schema layout + endpoint-facing table allowlist.

DuckLake is laid out one schema per dataset version: a version's tables live in
`ducklake.<slug>_v<n>.<table>` (e.g. `ducklake.nys_voter_file_v1.persons_geocoded`).
Schemas are created on demand by `ensure_schema(conn, schema)` before any DAG
node writes; FQNs are built with `table_fqn(schema, table)`. An org's data is
resolved *through* its active dataset version — see `resolve_schema`.

Endpoint SQL templates reference logical table names like `{persons_geocoded}`
instead of hard-coded FQNs, and `resolve(sql, schema)` substitutes them at
execution time. `QUERYABLE_TABLES` is the allowlist of placeholder names valid
in those templates — a typo (`{persons_typoed}`) raises loudly instead of
producing bad SQL.

DAG writers (`matching.py`, `assembly.py`, `aggregate.py`, etc.) call
`table_fqn` directly with bare string literals; they write many internal
intermediate tables (`persons_decomposed`, `persons_scored`, etc.) that
intentionally aren't in `QUERYABLE_TABLES` because the HTTP API
shouldn't reach into them.
"""

import re
from typing import TYPE_CHECKING

from src.duckdb import OPERATIONAL_PG_ALIAS, attach_operational_postgres
from src.models import quote_ident

if TYPE_CHECKING:
    import duckdb
    from src.settings import Settings

# Operational catalog hosting all per-org tenant data. Geo data lives in
# its own catalog (`geo_ducklake`) and is shared across orgs, so it stays
# outside this module's concern.
PERSON_CATALOG = "ducklake"

# Allowlist of placeholder names that endpoints may reference in SQL
# templates via `{name}`. The name doubles as the bare table name inside
# the dataset-version schema, so resolution is `table_fqn(schema, name)`.
QUERYABLE_TABLES: frozenset[str] = frozenset(
    {
        "persons_geocoded",
        "buildings_geocoded",
        "doors_geocoded",
    }
)

# Matches `{abstract_name}` where `abstract_name` is lowercase letters
# and underscores. Anchored on `{...}` so it can't accidentally match
# bare column names or string literals.
_PLACEHOLDER_RE = re.compile(r"\{([a-z_]+)\}")


class UnknownAbstractTableError(KeyError):
    """A placeholder referenced a name not in `QUERYABLE_TABLES`."""


def schema_fqn(schema: str) -> str:
    """Fully-qualified name for a DuckLake `schema` (no table).

    Quoted only when necessary (see `models.quote_ident`), so plain names
    (`nys_voter_file_v1`) stay readable and any with hyphens still produce
    valid SQL.
    """
    return f"{PERSON_CATALOG}.{quote_ident(schema)}"


def table_fqn(schema: str, table: str) -> str:
    """Fully-qualified name for `table` in `schema`."""
    return f"{schema_fqn(schema)}.{table}"


def ensure_schema(conn: "duckdb.DuckDBPyConnection", schema: str) -> None:
    """Idempotently create `schema`. Call once before any DAG node writes
    a dataset version's tables into it."""
    conn.execute(f"CREATE SCHEMA IF NOT EXISTS {schema_fqn(schema)}")


def drop_schema(conn: "duckdb.DuckDBPyConnection", schema: str) -> None:
    """Drop `schema` and every table in it. Use after a pipeline schema
    change forces a rebuild from scratch."""
    conn.execute(f"DROP SCHEMA IF EXISTS {schema_fqn(schema)} CASCADE")


def resolve(sql: str, schema: str) -> str:
    """Replace `{name}` placeholders in `sql` with the FQN for that table in
    `schema` (a dataset-version schema, e.g. `nys_voter_file_v1`). Raises
    `UnknownAbstractTableError` if any placeholder isn't in `QUERYABLE_TABLES`
    — fail loud rather than silently leave a `{...}` token in the executed SQL.
    """

    def _replace(m: re.Match[str]) -> str:
        name = m.group(1)
        if name not in QUERYABLE_TABLES:
            raise UnknownAbstractTableError(name)
        return table_fqn(schema, name)

    return _PLACEHOLDER_RE.sub(_replace, sql)


# ---------------------------------------------------------------------------
# Dataset-version schema resolution. Each dataset version's tables live in
# their own DuckLake schema `<dataset_slug>_v<versionNumber>` (e.g.
# `nys_voter_file_v1`). An org's data is resolved *through* its active dataset
# version — replacing the old per-org-schema model. See
# docs/plans/dataset-import-model.md.
# ---------------------------------------------------------------------------


def dataset_version_schema(dataset_slug: str, version_number: int) -> str:
    """Schema holding one dataset version's tables, e.g. `nys_voter_file_v1`."""
    return f"{dataset_slug}_v{version_number}"


def resolve_schema(
    conn: "duckdb.DuckDBPyConnection",
    settings: "Settings",
    org_slug: str,
) -> str:
    """Resolve an org to its active dataset version's DuckLake schema.

    org → dataset_organizations → dataset → active version → `<slug>_v<n>`.
    Raises `NoActiveDatasetError` when the org has no active dataset (the
    empty state — the web app gates data-dependent views until an import
    completes). Reads the operational Postgres via the shared attach.
    """
    attach_operational_postgres(conn, settings)
    row = conn.execute(
        f"""
        SELECT d.slug, v.version_number
        FROM {OPERATIONAL_PG_ALIAS}.public.dataset_organizations dorg
        JOIN {OPERATIONAL_PG_ALIAS}.public.organizations o
            ON o.organization_id = dorg.organization_id
        JOIN {OPERATIONAL_PG_ALIAS}.public.datasets d
            ON d.dataset_id = dorg.dataset_id
        JOIN {OPERATIONAL_PG_ALIAS}.public.dataset_versions v
            ON v.dataset_version_id = d.active_version_id
        WHERE o.slug = ?
        LIMIT 1
        """,
        [org_slug],
    ).fetchone()
    if row is None:
        raise NoActiveDatasetError(org_slug)
    dataset_slug, version_number = row
    return dataset_version_schema(dataset_slug, version_number)


class NoActiveDatasetError(RuntimeError):
    """An org has no active dataset (no import has completed for it)."""

    def __init__(self, org_slug: str) -> None:
        super().__init__(f"org {org_slug!r} has no active dataset")
        self.org_slug = org_slug
