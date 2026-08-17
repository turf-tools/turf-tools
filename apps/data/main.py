import array
import asyncio
import json
import logging
import os
import tempfile
import time
from contextlib import asynccontextmanager, suppress
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.background import BackgroundTask

from src import timing
from src.custom_fields import (
    append_custom_fields,
    custom_fields_fqn,
    custom_fields_table_for,
    load_upload_table,
    query_context,
    sync_registry,
)
from src.dsl.compile import boundary_key_expr_for, cascade_sql, criteria_to_where
from src.dsl.criteria import Criteria, KeyFilter
from src.dsl.resolve import resolve_criteria
from src.duckdb import (
    OPERATIONAL_PG_ALIAS,
    attach_operational_postgres,
    get_connection,
    refresh_s3_secret_on_shared_connection,
    s3_secret_expires,
)
from src.import_job import fail_interrupted_versions, import_dataset_version
from src.job_runner import JobManager
from src.publish_turfs import PublishTurfsRequest, publish_turfs
from src.quickwit import build_person_query, persons_index_id
from src.quickwit import search as quickwit_search
from src.settings import get_settings
from src.tables import (
    QUERYABLE_TABLES,
    NoActiveDatasetError,
    dataset_version_schema,
    resolve,
    resolve_version,
    table_fqn,
)
from src.timing import timed

logger = logging.getLogger("uvicorn")

settings = get_settings()


def _log_background_task_failure(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    try:
        exc = task.exception()
    except asyncio.CancelledError:
        return
    if exc is not None:
        logger.exception("Background task %s stopped unexpectedly", task.get_name(), exc_info=exc)


# Cadence for forcing a fresh credential-chain walk on the shared DuckDB
# connection. EC2 instance-profile STS tokens are typically valid for ~6h;
# 30 min leaves comfortable headroom for clock skew and scheduling slop.
# Driven manually because DuckDB's `REFRESH 'auto'` is wired only into the
# STS / web_identity branches of credential_chain (duckdb-aws#26).
_S3_SECRET_REFRESH_INTERVAL_SECONDS = 30 * 60


async def _refresh_s3_secret_forever() -> None:
    while True:
        await asyncio.sleep(_S3_SECRET_REFRESH_INTERVAL_SECONDS)
        try:
            # IMDS network call inside CREATE OR REPLACE — keep it off the
            # event loop so concurrent request handling doesn't pause.
            await asyncio.to_thread(refresh_s3_secret_on_shared_connection, settings)
            logger.info("Refreshed S3 SECRET on shared DuckDB connection")
        except Exception:
            logger.exception("S3 SECRET refresh failed; will retry on next tick")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # A read-only attach can't create a DuckLake catalog that doesn't exist yet
    # (a fresh box, before any import or seed). Build a write connection first —
    # its attach creates the empty catalogs if missing — so the read-only warmup
    # and serving paths can attach them. Idempotent; a no-op once they exist.
    try:
        get_connection(settings, read_only=False).close()
    except Exception:
        logger.exception("DuckLake catalog init failed; continuing")

    # Warm the shared connection's buffer pool so the first user request
    # doesn't pay cold S3 round-trips for Parquet footers + page reads. Only
    # active versions (org → active_dataset_version_id): old and pinned
    # versions stay cold and pay their own first-read cost.
    try:
        conn = get_connection(settings, read_only=True)
        attach_operational_postgres(conn, settings)
        versions = conn.execute(
            f"""
            SELECT DISTINCT d.slug, v.version_number
            FROM {OPERATIONAL_PG_ALIAS}.app.organizations o
            JOIN {OPERATIONAL_PG_ALIAS}.app.dataset_versions v
                ON v.dataset_version_id = o.active_dataset_version_id
            JOIN {OPERATIONAL_PG_ALIAS}.app.datasets d ON d.dataset_id = v.dataset_id
            """
        ).fetchall()
        # `count(COLUMNS(*))` expands at parse time to count(col1), count(col2), …
        # forcing DuckDB to read every column from Parquet — populates the buffer
        # pool so segment filtering + publish don't pay column-cold I/O on the
        # first user request.
        for slug, version_number in versions:
            schema = dataset_version_schema(slug, version_number)
            for table in sorted(QUERYABLE_TABLES):
                conn.execute(f"SELECT count(COLUMNS(*)) FROM {table_fqn(schema, table)}").fetchone()
        logger.info("Warmup completed (%d active version(s))", len(versions))
    except Exception:
        logger.exception("Warmup failed; continuing")

    # Create the asyncpg pool eagerly so a misconfigured DATABASE_URL
    # fails startup loudly instead of silently breaking the first job poll.
    from src.postgres import close_pool, get_pool

    await get_pool()

    job_manager_task = asyncio.create_task(
        JobManager(jobs=(import_dataset_version,), sweeps=(fail_interrupted_versions,)).run_forever(),
        name="job-manager",
    )
    job_manager_task.add_done_callback(_log_background_task_failure)

    # Only the AWS credential chain expires; static keys need no timer.
    s3_refresh_task = (
        asyncio.create_task(_refresh_s3_secret_forever(), name="s3-secret-refresh")
        if s3_secret_expires(settings)
        else None
    )
    if s3_refresh_task:
        s3_refresh_task.add_done_callback(_log_background_task_failure)

    try:
        yield
    finally:
        job_manager_task.cancel()
        if s3_refresh_task:
            s3_refresh_task.cancel()
            with suppress(asyncio.CancelledError):
                await s3_refresh_task
        with suppress(asyncio.CancelledError):
            await job_manager_task
        await close_pool()


# Read-side HTTP surface for the data service. Heavy work — voter-file
# loading, geocoding, Quickwit indexing — runs as Hamilton DAGs via CLI
# jobs. This service exposes health and endpoints for data queries.
app = FastAPI(title="Data Service", lifespan=lifespan)


@app.middleware("http")
async def server_timing(request: Request, call_next):
    # Phase timings for the browser's Network panel and the bench harness;
    # phases register via `src.timing.timed` anywhere on the call path.
    timing.start_request()
    t0 = time.perf_counter()
    response = await call_next(request)
    response.headers["Server-Timing"] = timing.header_value((time.perf_counter() - t0) * 1000)
    return response


# Permissive CORS for dev. Lock down via a
# settings-driven allow list before deploying.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.exception_handler(NoActiveDatasetError)
async def _no_active_dataset_handler(_request, exc: NoActiveDatasetError) -> JSONResponse:
    # An org that hasn't activated a dataset version yet is an expected empty
    # state, not a server fault. The web gates data-dependent views on this
    # (`organizations.active_dataset_version_id` is null), but any request that slips
    # through gets a clean 409 with a stable `code` instead of a 500 stack trace.
    return JSONResponse(
        status_code=409,
        content={"detail": str(exc), "code": "no_active_dataset"},
    )


@app.get("/healthcheck")
async def healthcheck():
    return {"status": "ok"}


@app.get("/ducklake/status")
async def ducklake_status():
    conn = get_connection(settings, read_only=True)
    tables = conn.execute("SHOW TABLES").fetchall()
    table_info = {}
    for (table_name,) in tables:
        columns = conn.execute(f"DESCRIBE {table_name}").fetchall()
        table_info[table_name] = [{"name": col[0], "type": col[1]} for col in columns]
    return {
        "status": "ok",
        "tables": table_info,
    }


@app.get("/key-groups/{key_group}/geojson")
async def key_group_geojson(key_group: str, org_slug: str):
    """Serve all polygons for a key group as a GeoJSON FeatureCollection.

    Reads from ``ducklake.{org_slug}.{key_group}`` (populated by the
    `seed-boundaries` CLI). Polygons are pre-simplified at load time, so the
    response is sized for map rendering rather than raw fidelity.

    Cached aggressively — boundary tables only change when an admin
    re-seeds them. When that happens, append a bumped `?v=` query param at
    the call site to bust browser caches.
    """

    def build() -> str:
        conn = get_connection(settings, read_only=True)
        schema = resolve_version(conn, settings, org_slug).schema
        # Validate the table exists before querying — keeps the error message
        # friendlier than a generic SQL failure.
        fqn = table_fqn(schema, key_group)
        try:
            conn.execute(f"SELECT 1 FROM {fqn} LIMIT 0")
        except Exception as e:
            raise HTTPException(
                status_code=404,
                detail=f"No boundary table for org_slug={org_slug}, "
                f"key_group={key_group}. Run `uv run seed-boundaries`.",
            ) from e

        # Build the FeatureCollection in DuckDB to avoid pulling raw geometry
        # into Python and re-serializing.
        rows = conn.execute(f"""
            SELECT json_object(
                'type', 'FeatureCollection',
                'features', json_group_array(json_object(
                    'type', 'Feature',
                    'properties', json_object('key', key, 'name', name),
                    'geometry', ST_AsGeoJSON(geom)::JSON
                ))
            )
            FROM {fqn}
        """).fetchone()
        return rows[0] if rows else '{"type":"FeatureCollection","features":[]}'

    # Long synchronous DuckDB query — run off the event loop so other
    # requests keep being served while it builds.
    body = await asyncio.to_thread(build)

    return Response(
        content=body,
        media_type="application/geo+json",
        headers={
            # Effectively forever; bust by versioning the URL when contents change.
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


@app.post("/custom-fields/inspect")
async def custom_fields_inspect(request: Request):
    """Parse an append file's shape: raw body in, column names out (or 400
    with the parse error). Stateless — nothing persists; the full file
    uploads once, on append. The dialog sends CSVs as a head slice (the
    header is all that's needed) and reads parquet footers client-side, but
    this endpoint is format-agnostic: DuckDB is the only CSV dialect sniffer,
    so the form shape can never diverge from what append will see."""
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload.")
    with tempfile.NamedTemporaryFile(suffix=".upload") as tmp:
        tmp.write(data)
        tmp.flush()
        conn = get_connection(settings)
        try:
            try:
                columns = await asyncio.to_thread(load_upload_table, conn, tmp.name)
            except Exception as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        finally:
            conn.close()
    return {"columns": columns}


@app.post("/custom-fields/append")
async def custom_fields_append(
    request: Request,
    dataset_id: str = Query(alias="datasetId"),
    dataset_slug: str = Query(alias="datasetSlug"),
    field_type: str = Query(alias="fieldType"),
    upload_id: str = Query(alias="uploadId"),
    label: str | None = Query(default=None),
    value: str | None = Query(default=None),
):
    """Synchronous append: raw file body + config in query params → parse →
    registry upsert → lake write → coverage/enum sync → stats out, or 400
    with the parse error (nothing written). The web edge authenticates,
    generates `uploadId`, and records provenance after success; lake rows
    carry the id so every value traces back to its upload."""
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload.")

    def run(source: str) -> dict:
        conn = get_connection(settings)
        try:
            return append_custom_fields(
                conn,
                dataset_id=dataset_id,
                dataset_slug=dataset_slug,
                upload_id=upload_id,
                source=source,
                field_type=field_type,
                label=label,
                value=value,
            )
        finally:
            conn.close()

    with tempfile.NamedTemporaryFile(suffix=".upload") as tmp:
        tmp.write(data)
        tmp.flush()
        try:
            return await asyncio.to_thread(run, tmp.name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


# Request models accept the camelCase wire shape sent by the TS web tier
# while exposing snake_case Python attributes. `populate_by_name=True` lets
# internal callers (tests, ad-hoc construction) use the Python field name.
class _WireBaseModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class _CustomFieldClearRequest(_WireBaseModel):
    dataset_slug: str = Field(validation_alias="datasetSlug")
    field_id: str = Field(validation_alias="fieldId")


class _CustomFieldExamplesRequest(_WireBaseModel):
    dataset_slug: str = Field(validation_alias="datasetSlug")
    field_id: str = Field(validation_alias="fieldId")


@app.post("/custom-fields/examples")
async def custom_fields_examples(req: _CustomFieldExamplesRequest):
    """A handful of distinct values from a custom field — the field dialog's
    Examples row. Sampled from the lake values table (not the registry) so
    scalar fields work; Category fields never call this (their option set
    lives on the registry row)."""
    # Shared read-only connection — never close it (see get_connection).
    conn = get_connection(settings, read_only=True)
    table = custom_fields_table_for(conn, req.dataset_slug)
    if table is None:
        return {"values": []}
    rows = conn.execute(
        f"SELECT DISTINCT value FROM {table} WHERE field_id = ? ORDER BY random() LIMIT 10",
        [req.field_id],
    ).fetchall()
    return {"values": [r[0] for r in rows]}


@app.post("/custom-fields/clear")
async def custom_fields_clear(req: _CustomFieldClearRequest):
    """Clear a custom field: delete its values for everyone. The registry row
    stays (at zero coverage), ready for re-append. Synchronous — one DELETE +
    a registry sync, no file parsing. Field↔dataset ownership is checked at
    the web edge (the auth boundary), like every other endpoint's org_slug.
    History, if ever needed, is DuckLake snapshots — not application state.
    """
    conn = get_connection(settings)
    try:
        table = custom_fields_fqn(req.dataset_slug)
        try:
            conn.execute(f"DELETE FROM {table} WHERE field_id = ?", [req.field_id])
        except Exception:  # noqa: BLE001 — no values table yet: nothing to clear
            return {"ok": True}
        sync_registry(conn, req.dataset_slug, include_values=False)
    finally:
        conn.close()
    return {"ok": True}


class _PersonsCountRequest(_WireBaseModel):
    criteria: Criteria = Criteria()
    key_filter: KeyFilter | None = Field(default=None, validation_alias="keyFilter")
    org_slug: str = Field(validation_alias="orgSlug")


@app.post("/persons/count")
async def persons_count(req: _PersonsCountRequest):
    """Persons-level summary counts.

    Response shape: ``{personCount, doorCount, buildingCount}``.
    """
    conn = get_connection(settings, read_only=True)
    version, catalog = query_context(conn, req.org_slug)
    schema = version.schema
    criteria = resolve_criteria(req.criteria, conn, settings, req.org_slug)
    params: list = []
    where = criteria_to_where(catalog, criteria, req.key_filter, params)
    sql = resolve(
        f"""
        SELECT
            count(*) AS "personCount",
            count(DISTINCT door_i) AS "doorCount",
            count(DISTINCT building_i) AS "buildingCount"
        FROM {{persons_geocoded}}
        {where}
        """,
        schema,
    )
    with timed("query"):
        row = conn.execute(sql, params).fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="Persons count query returned no rows.")
    return {
        "personCount": row[0],
        "doorCount": row[1],
        "buildingCount": row[2],
    }


class _PersonsCountCascadeRequest(_WireBaseModel):
    criteria: Criteria = Criteria()
    org_slug: str = Field(validation_alias="orgSlug")


@app.post("/persons/count-cascade")
async def persons_count_cascade(req: _PersonsCountCascadeRequest):
    """Per-step person counts for the segment editor's waterfall panel.

    Returns one row per step (plus a baseline "all" row at index 0). Each
    row carries the absolute count after that step and the delta vs the
    prior row. The step verb (add/narrow/remove) determines how each step
    modifies the running set.
    """
    conn = get_connection(settings, read_only=True)
    version, catalog = query_context(conn, req.org_slug)
    criteria = resolve_criteria(req.criteria, conn, settings, req.org_slug)
    persons_table = resolve("{persons_geocoded}", version.schema)
    params: list = []
    sql = cascade_sql(catalog, criteria, persons_table, params)
    with timed("query"):
        row = conn.execute(sql, params).fetchone()
    counts = list(row)
    steps_result = []
    prev = counts[0]
    steps_result.append({"count": prev, "delta": None})
    for c in counts[1:]:
        steps_result.append({"count": c, "delta": c - prev})
        prev = c
    return {"steps": steps_result}


class _PersonsSampleRequest(_WireBaseModel):
    criteria: Criteria = Criteria()
    key_filter: KeyFilter | None = Field(default=None, validation_alias="keyFilter")
    org_slug: str = Field(validation_alias="orgSlug")
    limit: int = 100


@app.post("/persons/sample")
async def persons_sample(req: _PersonsSampleRequest):
    """Row-level sample of people matching the criteria.

    Response shape: ``{persons: [{firstName, middleName, lastName, nameSuffix,
    addressLine1, addressLine2, city, state, zip5}, ...]}``. Used by the segment
    editor's list-view preview. Capped at ``limit`` (default 100).
    """
    limit = max(1, min(req.limit, 500))
    conn = get_connection(settings, read_only=True)
    version, catalog = query_context(conn, req.org_slug)
    schema = version.schema
    criteria = resolve_criteria(req.criteria, conn, settings, req.org_slug)
    params: list = []
    where = criteria_to_where(catalog, criteria, req.key_filter, params)
    sql = resolve(
        f"""
        SELECT * FROM (
            SELECT first_name, middle_name, last_name, name_suffix,
                   address_line_1, address_line_2, city, state, zip5
            FROM {{persons_geocoded}}
            {where}
        ) USING SAMPLE {limit} ROWS
        """,
        schema,
    )
    with timed("query"):
        rows = conn.execute(sql, params).fetchall()
    return {
        "persons": [
            {
                "firstName": r[0],
                "middleName": r[1],
                "lastName": r[2],
                "nameSuffix": r[3],
                "addressLine1": r[4],
                "addressLine2": r[5],
                "city": r[6],
                "state": r[7],
                "zip5": r[8],
            }
            for r in rows
        ]
    }


class _PersonsSearchRequest(_WireBaseModel):
    org_slug: str = Field(validation_alias="orgSlug")
    first_name: str = Field("", validation_alias="firstName")
    last_name: str = Field("", validation_alias="lastName")
    address: str = ""
    city: str = ""
    zip: str = ""  # noqa: A003
    external_id: str = Field("", validation_alias="externalId")
    limit: int = 25
    offset: int = 0


@app.post("/persons/search")
async def persons_search(req: _PersonsSearchRequest):
    """Structured person search (name / address / id, AND-ed) over the org's
    active-version Quickwit index — powers the Lookup tab. Name/address prefix-
    match; results are paginated. Empty when no fields are filled or the version
    has no index yet.
    """
    query = build_person_query(
        first_name=req.first_name,
        last_name=req.last_name,
        address=req.address,
        city=req.city,
        zip5=req.zip,
        external_id=req.external_id,
    )
    if not query:
        return {"numHits": 0, "hits": [], "offset": req.offset, "limit": req.limit}
    conn = get_connection(settings, read_only=True)
    version = resolve_version(conn, settings, req.org_slug)
    index_id = persons_index_id(version.schema)
    result = quickwit_search(
        settings,
        index_id,
        query,
        max_hits=max(1, min(req.limit, 100)),
        start_offset=max(0, req.offset),
        # A→Z by name. sort_key_hi/lo pack the name into sortable u64s (see the
        # quickwit DAG); on 0.8.2 the `-` prefix is ascending (its default is
        # descending, opposite the newer docs).
        sort_by="-sort_key_hi,-sort_key_lo",
    )
    return {**result, "offset": req.offset, "limit": req.limit}


class _PersonDetailRequest(_WireBaseModel):
    org_slug: str = Field(validation_alias="orgSlug")
    external_id: str = Field(validation_alias="externalId")


@app.post("/persons/detail")
async def person_detail(req: _PersonDetailRequest):
    """The full lake record for one person (by external_id) — the Lookup detail
    pane. The search index only holds name/address; everything else (party,
    districts, voting history, …) lives in `persons_geocoded`. Returns
    ``{person: {<column>: value, …, votingHistory: [...]}}`` or ``{person: null}``.
    """
    conn = get_connection(settings, read_only=True)
    version = resolve_version(conn, settings, req.org_slug)
    # Return every column (we don't have the manifest here to whitelist), minus a
    # few internal geocoding/matching fields the detail pane never shows. These
    # always exist on persons_geocoded, so EXCLUDE is safe.
    sql = resolve(
        "SELECT * EXCLUDE ("
        "voting_history, building_id, door_id, building_i, door_i, blockface_id, "
        "match_score, position_source, latitude, longitude"
        "), to_json(voting_history) AS voting_history "
        "FROM {persons_geocoded} WHERE external_id = ? LIMIT 1",
        version.schema,
    )
    cursor = conn.execute(sql, [req.external_id])
    row = cursor.fetchone()
    if row is None:
        return {"person": None}
    person = dict(zip([d[0] for d in cursor.description], row, strict=True))
    person["votingHistory"] = json.loads(person.pop("voting_history") or "[]")
    return {"person": person}


class _PersonsCountByKeyRequest(_WireBaseModel):
    criteria: Criteria = Criteria()
    key_filter: KeyFilter | None = Field(default=None, validation_alias="keyFilter")
    key_group: str = Field(validation_alias="keyGroup")
    org_slug: str = Field(validation_alias="orgSlug")


@app.post("/persons/count-by-key")
async def persons_count_by_key(req: _PersonsCountByKeyRequest):
    """Per-key (per ED, per ZIP, …) aggregation of doors + people for a
    given criteria + optional spatial scope.

    Drives the zone editor's heatmap overlay and the campaign editor's
    boundary tinting. Response shape:
    ``{counts: {<key>: {doors, people}, ...}}``.
    """
    conn = get_connection(settings, read_only=True)
    version, catalog = query_context(conn, req.org_slug)
    schema = version.schema
    group_expr = boundary_key_expr_for(catalog, req.key_group)
    criteria = resolve_criteria(req.criteria, conn, settings, req.org_slug)
    params: list = []
    where = criteria_to_where(catalog, criteria, req.key_filter, params)
    sql = resolve(
        f"""
        SELECT
            {group_expr} AS key,
            count(DISTINCT door_i) AS doors,
            count(*) AS people
        FROM {{persons_geocoded}}
        {where}
        GROUP BY {group_expr}
        """,
        schema,
    )
    with timed("query"):
        rows = conn.execute(sql, params).fetchall()
    counts: dict[str, dict[str, int]] = {}
    for key, doors, people in rows:
        if key is None:
            continue
        counts[key] = {
            "doors": int(doors),
            "people": int(people),
        }
    return {"counts": counts}


class _SegmentExportRequest(_WireBaseModel):
    criteria: Criteria = Criteria()
    org_slug: str = Field(validation_alias="orgSlug")
    format: str = "csv"


# The exported columns, in order, under their own names — the Person contract
# (models.py) as it survives assembly. No half_code: assembly consumes it into
# canonical address_line_1 ("123 1/2 MAIN ST"). Required-contract columns are
# always selected, so genuine pipeline drift fails loudly; the contract-optional
# four are included only when the version's table has them. Dataset-specific
# columns are not exported.
_EXPORT_COLUMNS = [
    "external_id",
    "external_id_type",
    "first_name",
    "middle_name",
    "last_name",
    "name_suffix",
    "address_line_1",
    "address_line_2",
    "city",
    "state",
    "zip5",
    "zip4",
]
# `| None = None` on Person — an importer may omit these columns entirely.
_EXPORT_OPTIONAL = {"middle_name", "name_suffix", "address_line_2", "zip4"}


@app.post("/segments/export")
async def segments_export(req: _SegmentExportRequest):
    """Stream a segment's matched persons as CSV or Parquet.

    Resolves the criteria (same path as /persons/count), writes the canonical
    columns to a temp file via DuckDB COPY, and returns it as a download. A
    background task removes the temp file after the response is sent.
    `X-Export-Rows` carries the row count so the caller can log it.
    """
    if req.format not in ("csv", "parquet"):
        raise HTTPException(status_code=400, detail="format must be 'csv' or 'parquet'.")

    conn = get_connection(settings, read_only=True)
    version, catalog = query_context(conn, req.org_slug)
    schema = version.schema
    criteria = resolve_criteria(req.criteria, conn, settings, req.org_slug)
    params: list = []
    where = criteria_to_where(catalog, criteria, None, params)
    persons_columns = {row[0] for row in conn.execute(f"DESCRIBE {resolve('{persons_geocoded}', schema)}").fetchall()}
    # Skip only optional-and-absent; a missing required column stays in the
    # SELECT and fails loudly at bind time.
    select_cols = ", ".join(c for c in _EXPORT_COLUMNS if c in persons_columns or c not in _EXPORT_OPTIONAL)
    select_sql = resolve(f"SELECT {select_cols} FROM {{persons_geocoded}} {where}", schema)

    suffix = ".parquet" if req.format == "parquet" else ".csv"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix="segment-export-")
    os.close(fd)
    # `tmp_path` is server-generated and the COPY options are from a fixed
    # allowlist, so the only untrusted input (criteria) stays in bound `params`.
    copy_opts = "FORMAT parquet" if req.format == "parquet" else "FORMAT csv, HEADER"
    copy_sql = f"COPY ({select_sql}) TO '{tmp_path}' ({copy_opts})"
    try:
        row = conn.execute(copy_sql, params).fetchone()
    except Exception:
        with suppress(OSError):
            os.remove(tmp_path)
        raise
    row_count = int(row[0]) if row else 0

    media = "application/octet-stream" if req.format == "parquet" else "text/csv"
    return FileResponse(
        tmp_path,
        media_type=media,
        filename=f"segment-export{suffix}",
        background=BackgroundTask(os.remove, tmp_path),
        headers={"X-Export-Rows": str(row_count)},
    )


class _BuildingsListRequest(_WireBaseModel):
    criteria: Criteria = Criteria()
    key_filter: KeyFilter | None = Field(default=None, validation_alias="keyFilter")
    org_slug: str = Field(validation_alias="orgSlug")


@app.post("/buildings/list")
async def buildings_list(req: _BuildingsListRequest):
    """One row per building containing at least one matching person,
    with door + person counts and the building's centroid.

    Used by the turf cutter to render buildings scoped to criteria ∩
    zone, with enough detail to compute "what's inside this drawn
    polygon" client-side.
    """
    conn = get_connection(settings, read_only=True)
    version, catalog = query_context(conn, req.org_slug)
    schema = version.schema
    criteria = resolve_criteria(req.criteria, conn, settings, req.org_slug)
    params: list = []
    where = criteria_to_where(catalog, criteria, req.key_filter, params)
    sql = resolve(
        f"""
        SELECT
            b.building_id              AS "buildingId",
            b.longitude,
            b.latitude,
            count(DISTINCT fp.door_i)  AS "doorCount",
            count(*)                   AS "personCount"
        FROM {{buildings_geocoded}} b
        JOIN (
            SELECT building_id, door_i FROM {{persons_geocoded}} {where}
        ) fp ON fp.building_id = b.building_id
        GROUP BY b.building_id, b.longitude, b.latitude
        """,
        schema,
    )
    with timed("query"):
        cursor = conn.execute(sql, params)
        cols = [d[0] for d in cursor.description]
        rows = [dict(zip(cols, row, strict=True)) for row in cursor.fetchall()]
    return {"buildings": rows}


class _BuildingsPointsRequest(_WireBaseModel):
    criteria: Criteria = Criteria()
    key_filter: KeyFilter | None = Field(default=None, validation_alias="keyFilter")
    org_slug: str = Field(validation_alias="orgSlug")


@app.post("/buildings/points")
async def buildings_points(req: _BuildingsPointsRequest):
    """Binary mercator-delta pairs for buildings whose contained persons
    match the criteria.

    Wire format: 16-byte header of two fp64 (origin_x, origin_y in
    MapLibre [0,1] mercator), then N*8 bytes of fp32 (dx, dy) where each
    pair is the building's mercator coord minus the origin.

    The origin is the centroid of the returned points, kept at fp64 so
    the browser-side `cameraMerc - origin` subtraction stays precise.
    Storing deltas (not absolute mercator) lets fp32 spend its full
    mantissa on intra-cluster precision. Gives millimeter-scale at z20
    instead of meter-scale.
    """
    conn = get_connection(settings, read_only=True)
    version, catalog = query_context(conn, req.org_slug)
    schema = version.schema
    criteria = resolve_criteria(req.criteria, conn, settings, req.org_slug)
    params: list = []
    where = criteria_to_where(catalog, criteria, req.key_filter, params)
    sql = resolve(
        f"""
        WITH pts AS (
            SELECT
                (b.longitude + 180.0) / 360.0 AS mx,
                0.5 - ln(tan(pi()/4 + radians(b.latitude)/2)) / (2*pi()) AS my
            FROM {{buildings_geocoded}} b
            WHERE b.building_i IN (
                SELECT DISTINCT building_i FROM {{persons_geocoded}} {where}
            )
        ),
        o AS (SELECT avg(mx) AS ox, avg(my) AS oy FROM pts)
        SELECT pts.mx - o.ox AS dx, pts.my - o.oy AS dy, o.ox AS ox, o.oy AS oy
        FROM pts, o
        """,
        schema,
    )
    # fetchnumpy + vectorized repack: materializing hundreds of thousands of
    # rows as Python tuples costs several times the query itself.
    with timed("query"):
        cursor = conn.execute(sql, params)
        cols = cursor.fetchnumpy()
    dx, dy = cols["dx"], cols["dy"]
    if len(dx) == 0:
        return Response(
            content=array.array("d", [0.0, 0.0]).tobytes(),
            media_type="application/octet-stream",
        )
    header = np.array([cols["ox"][0], cols["oy"][0]], dtype=np.float64)
    deltas = np.empty((len(dx), 2), dtype=np.float32)
    deltas[:, 0] = dx
    deltas[:, 1] = dy
    return Response(
        content=header.tobytes() + deltas.tobytes(),
        media_type="application/octet-stream",
    )


@app.post("/turfs/publish")
async def turfs_publish(req: PublishTurfsRequest) -> dict[str, Any]:
    return await publish_turfs(req)
