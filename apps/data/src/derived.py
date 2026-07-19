"""Version-level derived metadata — properties computed once from a dataset
version's data at import time and cached on `dataset_versions.derived_metadata`
(Postgres), so reads never recompute them over the immutable version's rows.

Computed here (data already hot post-import) and written by `finalize_version`;
the web reads the blob straight from Postgres, like it reads the manifest. Add a
new derived property by extending `compute_derived_metadata`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from src.dsl.elections import ELECTION_MIN_VOTERS, election_key_sql, election_label

if TYPE_CHECKING:
    import duckdb
    from src.importers.base import Manifest


def compute_derived_metadata(conn: duckdb.DuckDBPyConnection, geocoded_fqn: str, manifest: Manifest) -> dict[str, Any]:
    """Derive all cached properties for a freshly-built version. `geocoded_fqn`
    is the persons_geocoded table; `manifest` drives what's derivable. Callers
    read `rowCount` back from the result (it replaces a separate count query)."""
    derived: dict[str, Any] = {
        "rowCount": conn.execute(f"SELECT count(*) FROM {geocoded_fqn}").fetchone()[0],
    }
    elections = _compute_elections(conn, geocoded_fqn, manifest)
    if elections is not None:
        derived["elections"] = elections
    return derived


def _compute_elections(
    conn: duckdb.DuckDBPyConnection, geocoded_fqn: str, manifest: Manifest
) -> list[dict[str, str]] | None:
    """Distinct (year, type) elections above the voter-count floor — the
    voting-history-detail picker's options, newest first. None when the dataset
    has no such field."""
    field = next(
        (fd for section in manifest.fields for fd in section if fd.filter_kind == "voting-history-detail"),
        None,
    )
    if field is None:
        return None
    column = field.column or field.identifier
    # Same key expression the detail filter compiles against (`election_key_sql`),
    # so a picked value always matches a compiled predicate. The floor drops
    # degenerate keys (corrupt years, phantom off-cycle types) that only a handful
    # of voters carry.
    rows = conn.execute(
        f"""
        SELECT e.year AS year, e.type AS type, {election_key_sql("e")} AS key
        FROM {geocoded_fqn}, UNNEST({column}) AS t(e)
        WHERE e.year IS NOT NULL
        GROUP BY 1, 2, 3
        HAVING count(DISTINCT external_id) >= ?
        """,
        [ELECTION_MIN_VOTERS],
    ).fetchall()
    # Newest first: year desc, then type.
    rows.sort(key=lambda r: (-r[0], r[1]))
    return [{"value": key, "label": election_label(year, type_)} for year, type_, key in rows]
