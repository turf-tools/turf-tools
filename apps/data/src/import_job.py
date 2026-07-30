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
from src.dags import aggregate, assembly, boundaries, geocode, matching, osm, quickwit, tiger
from src.derived import compute_derived_metadata
from src.duckdb import OPERATIONAL_PG_ALIAS, attach_operational_postgres, get_connection
from src.import_progress import ImportProgress, JobLog, ProgressNodeHook
from src.importers.registry import get_importer
from src.job_runner import JobContext, job
from src.quickwit import ensure_index, persons_index_id
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
        result = await asyncio.to_thread(_run, payload, str(ctx.job_id))
    except Exception as exc:
        # Surface the failure in the UI — mark the version `failed` and stash the
        # reason (pure Postgres, so it works even when the DuckLake attach is what
        # failed). Then re-raise so the job framework records it on the job row.
        await postgres.execute(
            "UPDATE app.dataset_versions SET status = 'failed', error = left($2, 1000) "
            "WHERE dataset_version_id = $1::uuid",
            payload.dataset_version_id,
            str(exc),
        )
        raise
    await ctx.message("Import complete", **result)
    return result


# Geocode-pipeline outputs, plus `tiger_tabblock_raw` — the census blocks the
# boundary step unions over (not otherwise built during import).
_FINAL_VARS = [
    "persons_geocoded",
    "geocoding_summary",
    "buildings_geocoded",
    "doors_geocoded",
    "tiger_tabblock_raw",
]


def _run(payload: ImportDatasetVersionPayload, job_id: str) -> dict[str, Any]:
    settings = get_settings()
    conn = get_connection(settings)
    try:
        slug, version_number, importer_name = _resolve_version(conn, settings, payload.dataset_version_id)
        log = JobLog(conn, job_id)
        schema = dataset_version_schema(slug, version_number)
        ensure_schema(conn, schema)

        importer = get_importer(importer_name)()
        manifest = importer.manifest()

        # One boundary table per key group the manifest declares (precinct →
        # nyc_eds, zip5 → nyc_zips); the field's `column` is the key expression.
        key_group_sources = [
            {"key_group": fd.key_group, "key_expression": fd.column}
            for section in manifest.fields
            for fd in section
            if fd.key_group is not None and fd.column is not None
        ]

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

        # Size progress from the importer's stages + the DAG's computed nodes +
        # one boundary union per key group; the hook reports one step per node.
        progress = ImportProgress(conn, payload.dataset_version_id)
        hook = ProgressNodeHook(progress, input_keys)
        dr = (
            driver.Builder()
            .with_modules(tiger, osm, matching, geocode, assembly, aggregate, boundaries)
            .with_adapters(hook)
            .build()
        )
        dag_steps = sum(1 for n in dr.graph.get_upstream_nodes(_FINAL_VARS)[0] if n.name not in input_keys)
        # +2 for the post-DAG passes not in the main graph: the Quickwit index
        # build and the derived-metadata unnest+count — so the bar doesn't sit
        # "stuck" near 100% while they run.
        progress.start(importer.PROGRESS_STEPS + dag_steps + len(key_group_sources) + 2)

        # Source → persons_validated (importer-specific), then the shared pipeline.
        persons_validated = importer.load(payload.source, schema, conn, progress)
        decoded = conn.execute(f"SELECT count(*) FROM {persons_validated.fqn}").fetchone()
        log.write(f"Decoded {decoded[0]:,} people from source" if decoded else "Source decoded")
        result = dr.execute(final_vars=_FINAL_VARS, inputs={"persons_validated": persons_validated, **dag_inputs})
        log.write("Geocoding pipeline complete")

        # Build each key group's polygons before finalize, so a `ready` version
        # is always zonable and the map's boundary fetch never 404s. Override the
        # two heavy inputs with the tables just built so each group runs only the
        # union.
        for source in key_group_sources:
            dr.execute(
                final_vars=["boundary_from_blocks"],
                inputs={
                    "schema": schema,
                    "conn": conn,
                    "key_group": source["key_group"],
                    "key_expression": source["key_expression"],
                },
                overrides={
                    "persons_geocoded": result["persons_geocoded"],
                    "tiger_tabblock_raw": result["tiger_tabblock_raw"],
                },
            )
        if key_group_sources:
            groups = len(key_group_sources)
            log.write(f"Built boundaries for {groups} key group{'s' if groups != 1 else ''}")

        # Index persons into Quickwit for the search / Lookup feature — a
        # per-version index (`persons_<schema>`). Create it first (local-ingest
        # appends), then the DAG node bulk-loads via CLI local-ingest, publishing
        # to the shared Postgres metastore the searcher reads. Best-effort: search
        # is an add-on, so a Quickwit hiccup must not sink an expensive geocode
        # import — the version still becomes usable (segments/zones/canvass), and
        # search can be backfilled by reindexing. Failure is logged loudly.
        index_id = persons_index_id(schema)
        try:
            ensure_index(settings, index_id)
            # Hook-less driver: this is one progress unit (the explicit advance
            # below). Running it through the shared `dr` (with ProgressNodeHook)
            # would advance once per Quickwit node and blow past 100%.
            driver.Builder().with_modules(quickwit).build().execute(
                final_vars=["quickwit_build_manifest_stub"],
                inputs={
                    "persons_table_ref": result["persons_geocoded"],
                    "quickwit_binary_path": settings.quickwit_binary,
                    "quickwit_config_path": settings.quickwit_config_path,
                    "quickwit_index_id": index_id,
                    "quickwit_batch_size": settings.quickwit_batch_size,
                    "conn": conn,
                },
            )
            log.write("Search index built")
        except Exception as exc:  # noqa: BLE001 — search indexing is non-fatal
            print(f"WARNING: Quickwit indexing failed for {index_id}: {exc}", flush=True)
            log.write(f"Search indexing failed (non-fatal): {exc}", level="warning")
        progress.advance()

        geocoded_fqn = result["persons_geocoded"].fqn
        derived = compute_derived_metadata(conn, geocoded_fqn, manifest)
        progress.advance()
        finalize_version(conn, settings, payload.dataset_version_id, manifest, derived)
        return {"row_count": derived["rowCount"], "schema": schema}
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
        FROM {OPERATIONAL_PG_ALIAS}.app.dataset_versions v
        JOIN {OPERATIONAL_PG_ALIAS}.app.datasets d ON d.dataset_id = v.dataset_id
        WHERE v.dataset_version_id = ?
        """,
        [dataset_version_id],
    ).fetchone()
    if row is None:
        raise ValueError(f"dataset_version {dataset_version_id!r} not found")
    return row[0], row[1], row[2]
