"""The dataset-version import job, run by the job worker.

Keyed off a `dataset_versions` row: resolve its dataset (slug + importer) and
version number → schema, run the importer's `load` (source → persons_validated),
then the shared geocode DAG, then `finalize_version` (manifest + row_count +
`ready`). This is the production analogue of `seed-persons`, enqueued by the web
when an admin imports a dataset. The user then promotes it via "Make active".
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from hamilton import driver
from pydantic import BaseModel

from src import postgres
from src.dags import aggregate, assembly, geocode, matching, osm, tiger
from src.duckdb import OPERATIONAL_PG_ALIAS, attach_operational_postgres, get_connection
from src.import_progress import ImportProgress, ProgressNodeHook
from src.importers.registry import get_importer
from src.job_runner import JobContext, job
from src.settings import get_settings
from src.tables import dataset_version_schema, ensure_schema, finalize_version

if TYPE_CHECKING:
    import duckdb
    from src.settings import Settings


class ImportDatasetVersionPayload(BaseModel):
    dataset_version_id: str
    source: str  # path or object-storage key of the raw file the importer decodes


@job(task="import_dataset_version")
async def import_dataset_version(payload: ImportDatasetVersionPayload, ctx: JobContext) -> dict[str, Any]:
    await ctx.message("Import started", dataset_version_id=payload.dataset_version_id)
    try:
        # DuckDB + the geocode DAG are blocking (minutes); run off the event loop
        # so the worker keeps serving other jobs / the s3-secret refresh.
        result = await asyncio.to_thread(_run, payload)
    except Exception:
        # Surface the failure in the UI — mark the version `failed` (pure Postgres,
        # so it works even when the DuckLake attach is what failed). Then re-raise
        # so the job framework records the reason on the job row.
        await postgres.execute(
            "UPDATE dataset_versions SET status = 'failed' WHERE dataset_version_id = $1::uuid",
            payload.dataset_version_id,
        )
        raise
    await ctx.message("Import complete", **result)
    return result


# The shared geocode pipeline's outputs (the `final_vars` the DAG resolves).
_FINAL_VARS = ["persons_geocoded", "geocoding_summary", "buildings_geocoded", "doors_geocoded"]


def _run(payload: ImportDatasetVersionPayload) -> dict[str, Any]:
    settings = get_settings()
    conn = get_connection(settings)
    try:
        slug, version_number, importer_name = _resolve_version(conn, settings, payload.dataset_version_id)
        schema = dataset_version_schema(slug, version_number)
        ensure_schema(conn, schema)

        importer = get_importer(importer_name)()

        # Config inputs the DAG receives (provided, not computed nodes).
        dag_inputs = {
            "schema": schema,
            "tiger_year": settings.tiger_year,
            "tiger_state_fips": settings.tiger_state_fips,
            "tiger_county_fips": settings.tiger_county_fips,
            "tiger_data_dir": settings.tiger_data_dir,
            "osm_url": settings.osm_url,
            "osm_data_dir": settings.osm_data_dir,
            "conn": conn,
        }
        input_keys = set(dag_inputs) | {"persons_validated"}

        # Size progress from the importer's stages + the DAG's computed nodes;
        # the hook reports one step per node as the pipeline runs.
        progress = ImportProgress(conn, payload.dataset_version_id)
        hook = ProgressNodeHook(progress, input_keys)
        dr = (
            driver.Builder()
            .with_modules(tiger, osm, matching, geocode, assembly, aggregate)
            .with_adapters(hook)
            .build()
        )
        dag_steps = sum(1 for n in dr.graph.get_upstream_nodes(_FINAL_VARS)[0] if n.name not in input_keys)
        progress.start(importer.PROGRESS_STEPS + dag_steps)

        # Source → persons_validated (importer-specific), then the shared pipeline.
        persons_validated = importer.load(payload.source, schema, conn, progress)
        result = dr.execute(final_vars=_FINAL_VARS, inputs={"persons_validated": persons_validated, **dag_inputs})

        person_count = conn.sql(f"SELECT count(*) FROM {result['persons_geocoded'].fqn}").fetchone()[0]
        finalize_version(conn, settings, payload.dataset_version_id, importer.manifest(), person_count)
        return {"row_count": person_count, "schema": schema}
    finally:
        conn.close()


def _resolve_version(
    conn: duckdb.DuckDBPyConnection, settings: Settings, dataset_version_id: str
) -> tuple[str, int, str]:
    """Look up the version's dataset slug, version number, and importer name."""
    attach_operational_postgres(conn, settings)
    row = conn.execute(
        f"""
        SELECT d.slug, v.version_number, d.importer
        FROM {OPERATIONAL_PG_ALIAS}.public.dataset_versions v
        JOIN {OPERATIONAL_PG_ALIAS}.public.datasets d ON d.dataset_id = v.dataset_id
        WHERE v.dataset_version_id = ?
        """,
        [dataset_version_id],
    ).fetchone()
    if row is None:
        raise ValueError(f"dataset_version {dataset_version_id!r} not found")
    return row[0], row[1], row[2]
