"""Version-level derived metadata — properties computed once from a dataset
version's data at import time and cached on `dataset_versions.derived_metadata`
(Postgres), so reads never recompute them over the immutable version's rows.

Computed here (data already hot post-import) and written by `finalize_version`;
the web reads the blob straight from Postgres, like it reads the manifest. Add a
new derived property by extending `compute_derived_metadata`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from src.dsl.elections import ELECTIONS_TABLE, election_label

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
    elections = _read_elections(conn, geocoded_fqn, manifest)
    if elections is not None:
        derived["elections"] = elections
    return derived


def _read_elections(
    conn: duckdb.DuckDBPyConnection, geocoded_fqn: str, manifest: Manifest
) -> list[dict[str, Any]] | None:
    """The version's election registry — picker options + the bit assignment the
    compiler maps selected keys through. Read back from the `elections` table
    assembly wrote, the single bit-assignment source. None when the dataset has
    no voting-history-detail field."""
    field = next(
        (fd for section in manifest.fields for fd in section if fd.filter_kind == "voting-history-detail"),
        None,
    )
    if field is None:
        return None
    elections_fqn = f"{geocoded_fqn.rsplit('.', 1)[0]}.{ELECTIONS_TABLE}"
    rows = conn.execute(f"SELECT key, year, type, bit FROM {elections_fqn} ORDER BY bit").fetchall()
    return [{"value": key, "label": election_label(year, type_), "bit": bit} for key, year, type_, bit in rows]
