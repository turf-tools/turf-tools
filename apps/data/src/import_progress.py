"""Coarse import progress — a step/total counter on the dataset_versions row,
shown as a percentage in the Data UI while an import runs.

Advanced from two places: the importer (once per load stage) and a Hamilton node
hook (once per computed DAG node). Both share one connection; writes go through
the operational-Postgres attach — the same synchronous path `finalize_version`
uses — so no event loop is involved. Steps aren't equal wall-time (decoding a
large file is a single long step), so this is honest step-progress, not an ETA.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from hamilton.lifecycle import NodeExecutionHook

from src.duckdb import OPERATIONAL_PG_ALIAS

if TYPE_CHECKING:
    import duckdb


class ImportProgress:
    """Persists a monotonic `import_step` / `import_total` to one version row.
    Only ints reach the SQL, so interpolation is safe; the id is our own row."""

    def __init__(self, conn: duckdb.DuckDBPyConnection, dataset_version_id: str) -> None:
        self._conn = conn
        self._dvid = dataset_version_id
        self._step = 0
        self._total = 0

    def start(self, total: int) -> None:
        self._step = 0
        self._total = max(total, 0)
        self._write()

    def advance(self, n: int = 1) -> None:
        self._step = min(self._step + n, self._total)
        self._write()

    def _write(self) -> None:
        self._conn.execute(
            f"CALL postgres_execute('{OPERATIONAL_PG_ALIAS}', $ft$"
            f"UPDATE public.dataset_versions "
            f"SET import_step = {int(self._step)}, import_total_steps = {int(self._total)} "
            f"WHERE dataset_version_id = '{self._dvid}'$ft$)"
        )


class NullProgress:
    """No-op for callers without a version row to update (e.g. the dev seed)."""

    def start(self, total: int) -> None: ...

    def advance(self, n: int = 1) -> None: ...


class ProgressNodeHook(NodeExecutionHook):
    """Advances progress once per successful DAG node. Input/config nodes are
    skipped so the running count matches the precomputed `total`."""

    def __init__(self, progress: ImportProgress | NullProgress, input_keys: set[str]) -> None:
        self._progress = progress
        self._input_keys = input_keys

    def run_before_node_execution(self, **kwargs: Any) -> None: ...

    def run_after_node_execution(self, *, node_name: str, success: bool, **kwargs: Any) -> None:
        if success and node_name not in self._input_keys:
            self._progress.advance()
