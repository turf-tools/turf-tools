"""Per-org schema layout + endpoint-facing table allowlist.

DuckLake is laid out one schema per org: every tenant's tables live in
`ducklake.<slug>.<table>` (or `ducklake."<slug>".<table>` when the
slug needs quoting). Schemas are created on demand by
`ensure_org_schema(conn, slug)` before any DAG node writes; FQNs are
built with `org_fqn(slug, table)`.

Endpoint SQL templates reference logical table names like
`{persons_geocoded}` instead of hard-coded FQNs, and `resolve(sql, slug)`
substitutes them at execution time per-tenant. `QUERYABLE_TABLES` is
the allowlist of placeholder names that are valid in those templates —
a typo (`{persons_typoed}`) raises loudly instead of producing bad SQL.

DAG writers (`aggregate.py`, `geocode.py`, `voter_file_loader.py`) call
`org_fqn` directly with bare string literals; they write many internal
intermediate tables (`persons_decomposed`, `persons_scored`, etc.) that
intentionally aren't in `QUERYABLE_TABLES` because the HTTP API
shouldn't reach into them.
"""

import re
from typing import TYPE_CHECKING

from src.models import quote_ident

if TYPE_CHECKING:
    import duckdb

# Operational catalog hosting all per-org tenant data. Geo data lives in
# its own catalog (`geo_ducklake`) and is shared across orgs, so it stays
# outside this module's concern.
PERSON_CATALOG = "ducklake"

# Allowlist of placeholder names that endpoints may reference in SQL
# templates via `{name}`. The name doubles as the bare table name inside
# the org's schema, so resolution is `org_fqn(slug, name)`.
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


def org_fqn(slug: str, table: str) -> str:
    """Fully-qualified name for `table` in org `slug`'s schema.

    Schema is quoted only when necessary (see `models.quote_ident`), so
    plain slugs (`default`) stay readable and slugs with hyphens
    (`nyc-dsa`) still produce valid SQL.
    """
    return f"{PERSON_CATALOG}.{quote_ident(slug)}.{table}"


def ensure_org_schema(conn: "duckdb.DuckDBPyConnection", slug: str) -> None:
    """Idempotently create the per-org schema. Call once before any DAG
    node writes to a tenant's tables."""
    conn.execute(f"CREATE SCHEMA IF NOT EXISTS {PERSON_CATALOG}.{quote_ident(slug)}")


def resolve(sql: str, slug: str) -> str:
    """Replace `{name}` placeholders in `sql` with the FQN for `slug`'s
    copy of that table. Raises `UnknownAbstractTableError` if any
    placeholder isn't in `QUERYABLE_TABLES` — fail loud rather than
    silently leave a `{...}` token in the executed SQL.
    """

    def _replace(m: re.Match[str]) -> str:
        name = m.group(1)
        if name not in QUERYABLE_TABLES:
            raise UnknownAbstractTableError(name)
        return org_fqn(slug, name)

    return _PLACEHOLDER_RE.sub(_replace, sql)
