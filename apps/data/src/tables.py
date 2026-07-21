"""Dataset-version schema layout + endpoint-facing table allowlist.

DuckLake is laid out one schema per dataset version: a version's tables live in
`ducklake.<slug>_v<n>.<table>` (e.g. `ducklake.nys_voter_file_v1.persons_geocoded`).
Schemas are created on demand by `ensure_schema(conn, schema)` before any DAG
node writes; FQNs are built with `table_fqn(schema, table)`. An org's data is
resolved *through* its active dataset version — see `resolve_version`.

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

import json
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

from src.duckdb import OPERATIONAL_PG_ALIAS, attach_operational_postgres
from src.importers.base import Manifest
from src.models import quote_ident

if TYPE_CHECKING:
    import duckdb
    from src.settings import Settings

# Operational catalog hosting all per-org tenant data. Geo data lives in
# its own catalog (`ducklake_geo`) and is shared across orgs, so it stays
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
# version.
# ---------------------------------------------------------------------------


def dataset_version_schema(dataset_slug: str, version_number: int) -> str:
    """Schema holding one dataset version's tables, e.g. `nys_voter_file_v1`."""
    return f"{dataset_slug}_v{version_number}"


@dataclass(frozen=True)
class ResolvedVersion:
    """A resolved dataset version. Both the DuckLake `schema` and the field
    `manifest` are just properties of the version — a live segment resolves the
    active version, a published turf its pinned one, and each then derives the
    schema it queries and the manifest it compiles against from the same place.
    """

    dataset_version_id: str
    dataset_slug: str
    version_number: int
    manifest: Manifest

    @property
    def schema(self) -> str:
        return dataset_version_schema(self.dataset_slug, self.version_number)


def _parse_manifest(manifest: object) -> Manifest:
    """Parse a `dataset_versions.manifest` value into a `Manifest`. The Postgres
    jsonb comes back over the DuckDB attach as a JSON string (or an
    already-decoded container); reject NULL — an active/pinned version must
    carry its manifest."""
    if manifest is None:
        raise MissingManifestError()
    data = json.loads(manifest) if isinstance(manifest, str) else manifest
    return Manifest.model_validate(data)


def resolve_version(
    conn: "duckdb.DuckDBPyConnection",
    settings: "Settings",
    org_slug: str,
) -> ResolvedVersion:
    """Resolve an org to its active dataset version.

    org → dataset_organizations → dataset → active version. Raises
    `NoActiveDatasetError` when the org has no active dataset (the empty state —
    the web app gates data-dependent views until an import completes). Reads the
    operational Postgres via the shared attach.
    """
    attach_operational_postgres(conn, settings)
    row = conn.execute(
        f"""
        SELECT d.slug, v.version_number, v.dataset_version_id, v.manifest
        FROM {OPERATIONAL_PG_ALIAS}.public.organizations o
        JOIN {OPERATIONAL_PG_ALIAS}.public.dataset_versions v
            ON v.dataset_version_id = o.active_dataset_version_id
        JOIN {OPERATIONAL_PG_ALIAS}.public.datasets d
            ON d.dataset_id = v.dataset_id
        WHERE o.slug = ?
        """,
        [org_slug],
    ).fetchone()
    if row is None:
        raise NoActiveDatasetError(org_slug)
    dataset_slug, version_number, dataset_version_id, manifest = row
    return ResolvedVersion(
        dataset_version_id=str(dataset_version_id),
        dataset_slug=dataset_slug,
        version_number=version_number,
        manifest=_parse_manifest(manifest),
    )


def load_manifest(
    conn: "duckdb.DuckDBPyConnection",
    settings: "Settings",
    dataset_version_id: str,
) -> Manifest:
    """Load one version's field manifest by id — the single manifest path. A
    live segment feeds the dataset's active version id, a published turf its
    pinned id; both land here."""
    attach_operational_postgres(conn, settings)
    row = conn.execute(
        f"""
        SELECT manifest
        FROM {OPERATIONAL_PG_ALIAS}.public.dataset_versions
        WHERE dataset_version_id = ?
        """,
        [dataset_version_id],
    ).fetchone()
    if row is None:
        raise MissingManifestError(dataset_version_id)
    return _parse_manifest(row[0])


def version_id_for_schema(
    conn: "duckdb.DuckDBPyConnection",
    settings: "Settings",
    schema: str,
) -> str | None:
    """Find the `dataset_versions` row whose `<slug>_v<n>` schema equals
    `schema`. Returns None when no version row exists yet (e.g. the dev seed run
    before `db:mock`), letting the caller skip the manifest write rather than
    fail."""
    attach_operational_postgres(conn, settings)
    row = conn.execute(
        f"""
        SELECT v.dataset_version_id
        FROM {OPERATIONAL_PG_ALIAS}.public.dataset_versions v
        JOIN {OPERATIONAL_PG_ALIAS}.public.datasets d ON d.dataset_id = v.dataset_id
        WHERE d.slug || '_v' || v.version_number = ?
        """,
        [schema],
    ).fetchone()
    return str(row[0]) if row else None


def finalize_version(
    conn: "duckdb.DuckDBPyConnection",
    settings: "Settings",
    dataset_version_id: str,
    manifest: Manifest,
    derived_metadata: dict,
) -> None:
    """Land a version's `manifest` + `derived_metadata` and mark it `ready`, once
    its DuckLake tables are built. The single write point for both callers: the
    `import_dataset_version` job (production) and `seed-persons` (dev). The
    importer *derives* the manifest and the DuckDB connection already has the
    Postgres attach, so writing it here — rather than handing it back for the web
    to persist — keeps the version's data and its manifest landed in one place.
    `derived_metadata` is the caller's `compute_derived_metadata` result
    (`rowCount`, `elections`, …), cached so reads never recompute over the
    immutable version. `active_dataset_version_id` is left untouched: activation
    is the web's concern ("Make active"), which invalidates the web's caches.

    Postgres implicit-casts json→jsonb on INSERT but not on UPDATE, and DuckDB
    (no native jsonb type) sends the value as varchar — so a bound-param UPDATE
    into a jsonb column fails. The maintainer-blessed workaround is to run the
    UPDATE natively on Postgres via `postgres_execute` with an explicit `::jsonb`
    cast (duckdb/duckdb#16195). The values are our own serialized models, not user
    input; single quotes are doubled for the Postgres string literal and the
    statement is dollar-quoted for DuckDB.
    """
    attach_operational_postgres(conn, settings)
    manifest_literal = manifest.model_dump_json(by_alias=True).replace("'", "''")
    derived_literal = json.dumps(derived_metadata).replace("'", "''")
    conn.execute(
        f"CALL postgres_execute('{OPERATIONAL_PG_ALIAS}', $ft$"
        f"UPDATE public.dataset_versions "
        f"SET manifest = '{manifest_literal}'::jsonb, "
        f"derived_metadata = '{derived_literal}'::jsonb, status = 'ready' "
        f"WHERE dataset_version_id = '{dataset_version_id}'"
        f"$ft$)"
    )


class NoActiveDatasetError(RuntimeError):
    """An org has no active dataset (no import has completed for it)."""

    def __init__(self, org_slug: str) -> None:
        super().__init__(f"org {org_slug!r} has no active dataset")
        self.org_slug = org_slug


class MissingManifestError(RuntimeError):
    """A dataset version has no `manifest` (should be impossible for an
    active/pinned version — a data-integrity failure, not an empty state)."""

    def __init__(self, dataset_version_id: str | None = None) -> None:
        super().__init__(f"dataset version {dataset_version_id!r} has no manifest")
        self.dataset_version_id = dataset_version_id
