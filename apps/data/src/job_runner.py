"""Run operational jobs stored in Postgres."""

from __future__ import annotations

import asyncio
import inspect
import json
import traceback
import uuid
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol, get_type_hints, overload

from pydantic import BaseModel, ValidationError

type JobFunc = Callable[..., Any]
PayloadModel = type[BaseModel]

UNSTARTED = "unstarted"
IN_PROGRESS = "in_progress"
COMPLETED = "completed"
PERMANENTLY_FAILED = "permanently_failed"


@dataclass(frozen=True)
class ClaimedJob:
    """A job row claimed by a worker."""

    job_id: uuid.UUID
    task: str
    payload: Mapping[str, Any]
    concurrency_key: str | None


class JobStore(Protocol):
    """Persistence boundary used by the job manager."""

    async def claim_jobs(
        self,
        *,
        worker_id: str,
        tasks: Iterable[str],
        limit: int,
    ) -> list[ClaimedJob]: ...

    async def complete_job(self, *, job_id: uuid.UUID, result: Any) -> None: ...

    async def fail_job(self, *, job_id: uuid.UUID, failure_reason: str) -> None: ...

    async def write_message(self, *, job_id: uuid.UUID, payload: Mapping[str, Any]) -> None: ...


@dataclass(frozen=True)
class RegisteredJob:
    """A decorated job function and the model used to validate its payload."""

    task: str
    func: JobFunc
    payload_model: PayloadModel


class JobRegistry:
    """Registry populated by the `job` decorator."""

    def __init__(self) -> None:
        self._jobs: dict[str, RegisteredJob] = {}

    def register(self, registered_job: RegisteredJob) -> None:
        self._jobs[registered_job.task] = registered_job

    def get(self, task: str) -> RegisteredJob | None:
        return self._jobs.get(task)

    def tasks(self) -> list[str]:
        return sorted(self._jobs)

    def clear(self) -> None:
        self._jobs.clear()


DEFAULT_REGISTRY = JobRegistry()


class JobContext:
    """Runtime helpers passed to job functions."""

    def __init__(self, *, job_id: uuid.UUID, worker_id: str, store: JobStore) -> None:
        self.job_id = job_id
        self.worker_id = worker_id
        self._store = store

    async def message(
        self,
        message: str | Mapping[str, Any],
        *,
        level: str = "info",
        **fields: Any,
    ) -> None:
        if isinstance(message, str):
            payload = {"level": level, "message": message, **fields}
        else:
            payload = {"level": level, **dict(message), **fields}

        await self._store.write_message(job_id=self.job_id, payload=_jsonable(payload))


@overload
def job[TJobFunc: JobFunc](func: TJobFunc, /) -> TJobFunc: ...


@overload
def job[TJobFunc: JobFunc](
    func: None = None,
    /,
    *,
    task: str | None = None,
    payload_model: PayloadModel | None = None,
    registry: JobRegistry = DEFAULT_REGISTRY,
) -> Callable[[TJobFunc], TJobFunc]: ...


def job[TJobFunc: JobFunc](
    func: TJobFunc | None = None,
    /,
    *,
    task: str | None = None,
    payload_model: PayloadModel | None = None,
    registry: JobRegistry = DEFAULT_REGISTRY,
) -> TJobFunc | Callable[[TJobFunc], TJobFunc]:
    """Register a function as a runnable job."""

    def decorator(inner: TJobFunc) -> TJobFunc:
        registered_task = task or inner.__name__
        registered_model = payload_model or _infer_payload_model(inner)
        registry.register(RegisteredJob(task=registered_task, func=inner, payload_model=registered_model))
        return inner

    if func is None:
        return decorator

    return decorator(func)


class JobManager:
    """Claim jobs from Postgres and execute registered handlers."""

    def __init__(
        self,
        *,
        registry: JobRegistry = DEFAULT_REGISTRY,
        store: JobStore | None = None,
        worker_id: str | None = None,
        max_concurrent_jobs: int = 1,
        poll_interval_seconds: float = 1.0,
    ) -> None:
        if max_concurrent_jobs < 1:
            raise ValueError("max_concurrent_jobs must be at least 1")

        self.registry = registry
        self.store = store or PostgresJobStore()
        self.worker_id = worker_id or f"data-job-runner-{uuid.uuid4()}"
        self.max_concurrent_jobs = max_concurrent_jobs
        self.poll_interval_seconds = poll_interval_seconds

    async def run_once(self) -> int:
        tasks = self.registry.tasks()
        if not tasks:
            return 0

        claimed_jobs = await self.store.claim_jobs(
            worker_id=self.worker_id,
            tasks=tasks,
            limit=self.max_concurrent_jobs,
        )
        if not claimed_jobs:
            return 0

        await asyncio.gather(*(self._run_claimed_job(claimed_job) for claimed_job in claimed_jobs))
        return len(claimed_jobs)

    async def run_forever(self) -> None:
        """Poll for jobs until cancelled.

        A failed poll must never end the loop: the schema may not exist yet on a
        fresh deployment, and Postgres restarts. Failures back off and retry,
        logging the first of each consecutive run so a persistent outage doesn't
        flood the log at the poll interval.
        """
        consecutive_failures = 0
        while True:
            try:
                handled = await self.run_once()
                consecutive_failures = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — any failure is retryable
                if consecutive_failures == 0:
                    print(f"WARNING: job poll failed, retrying: {exc}", flush=True)
                consecutive_failures += 1
                await asyncio.sleep(min(self.poll_interval_seconds * consecutive_failures, 30.0))
                continue
            if handled == 0:
                await asyncio.sleep(self.poll_interval_seconds)

    async def _run_claimed_job(self, claimed_job: ClaimedJob) -> None:
        registered_job = self.registry.get(claimed_job.task)
        if registered_job is None:
            await self.store.fail_job(
                job_id=claimed_job.job_id,
                failure_reason=f"No registered job for task `{claimed_job.task}`.",
            )
            return

        try:
            payload = registered_job.payload_model.model_validate(claimed_job.payload)
        except ValidationError as exc:
            await self.store.write_message(
                job_id=claimed_job.job_id,
                payload={
                    "level": "error",
                    "message": "Job payload validation failed.",
                    "errors": exc.errors(),
                },
            )
            await self.store.fail_job(
                job_id=claimed_job.job_id,
                failure_reason=_truncate(str(exc)),
            )
            return

        context = JobContext(job_id=claimed_job.job_id, worker_id=self.worker_id, store=self.store)

        try:
            result = _call_registered_job(registered_job.func, payload, context)
            if inspect.isawaitable(result):
                result = await result
        except Exception as exc:
            await self.store.write_message(
                job_id=claimed_job.job_id,
                payload={
                    "level": "error",
                    "message": str(exc),
                    "exception_type": type(exc).__name__,
                    "traceback": traceback.format_exc(),
                },
            )
            await self.store.fail_job(job_id=claimed_job.job_id, failure_reason=_truncate(str(exc)))
            return

        await self.store.complete_job(job_id=claimed_job.job_id, result=_jsonable(result))


class PostgresJobStore:
    """Postgres-backed job store using the shared asyncpg pool."""

    async def claim_jobs(
        self,
        *,
        worker_id: str,
        tasks: Iterable[str],
        limit: int,
    ) -> list[ClaimedJob]:
        from src.postgres import fetch

        task_list = list(tasks)
        if not task_list:
            return []

        rows = await fetch(
            """
            WITH locked AS (
                SELECT j.job_id, j.task, j.payload, j.concurrency_key
                FROM jobs j
                WHERE j.status = $1
                  AND j.task = ANY($2::text[])
                  AND (
                    j.concurrency_key IS NULL
                    OR NOT EXISTS (
                        SELECT 1
                        FROM jobs active
                        WHERE active.status = $3
                          AND active.concurrency_key = j.concurrency_key
                    )
                  )
                ORDER BY j.job_id
                FOR UPDATE SKIP LOCKED
                LIMIT $4
            ),
            eligible AS (
                SELECT job_id
                FROM (
                    SELECT
                        job_id,
                        row_number() OVER (
                            PARTITION BY coalesce(concurrency_key, job_id::text)
                            ORDER BY job_id
                        ) AS concurrency_rank
                    FROM locked
                ) ranked
                WHERE concurrency_rank = 1
                LIMIT $5
            )
            UPDATE jobs
            SET status = $6, locked_by_worker_id = $7
            WHERE job_id IN (SELECT job_id FROM eligible)
            RETURNING job_id, task, payload, concurrency_key
            """,
            UNSTARTED,
            task_list,
            IN_PROGRESS,
            limit * 10,
            limit,
            IN_PROGRESS,
            worker_id,
        )

        return [
            ClaimedJob(
                job_id=row["job_id"],
                task=row["task"],
                payload=_payload_from_db(row["payload"]),
                concurrency_key=row["concurrency_key"],
            )
            for row in rows
        ]

    async def complete_job(self, *, job_id: uuid.UUID, result: Any) -> None:
        from src.postgres import execute

        await execute(
            """
            UPDATE jobs
            SET status = $1, result = $2::jsonb, failure_reason = NULL, locked_by_worker_id = NULL
            WHERE job_id = $3
            """,
            COMPLETED,
            json.dumps(_jsonable(result)),
            job_id,
        )

    async def fail_job(self, *, job_id: uuid.UUID, failure_reason: str) -> None:
        from src.postgres import execute

        await execute(
            """
            UPDATE jobs
            SET status = $1, failure_reason = $2, locked_by_worker_id = NULL
            WHERE job_id = $3
            """,
            PERMANENTLY_FAILED,
            failure_reason,
            job_id,
        )

    async def write_message(self, *, job_id: uuid.UUID, payload: Mapping[str, Any]) -> None:
        from src.postgres import execute

        await execute(
            """
            INSERT INTO job_messages (job_id, payload)
            VALUES ($1, $2::json)
            """,
            job_id,
            json.dumps(_jsonable(payload)),
        )


def _infer_payload_model(func: JobFunc) -> PayloadModel:
    signature = inspect.signature(func)
    type_hints = get_type_hints(func)
    for parameter in signature.parameters.values():
        annotation = type_hints.get(parameter.name, parameter.annotation)
        if inspect.isclass(annotation) and issubclass(annotation, BaseModel):
            return annotation

    name = getattr(func, "__name__", repr(func))
    raise TypeError(f"`{name}` needs a Pydantic payload model annotation or explicit payload_model.")


def _call_registered_job(func: JobFunc, payload: BaseModel, context: JobContext) -> Any:
    if _accepts_context(func):
        return func(payload, context)
    return func(payload)


def _accepts_context(func: JobFunc) -> bool:
    positional_params = [
        parameter
        for parameter in inspect.signature(func).parameters.values()
        if parameter.kind
        in (
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.VAR_POSITIONAL,
        )
    ]
    return (
        any(parameter.kind == inspect.Parameter.VAR_POSITIONAL for parameter in positional_params)
        or len(positional_params) >= 2
    )


def _jsonable(value: Any) -> Any:
    if value is None:
        return {}
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_jsonable(item) for item in value]
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


def _payload_from_db(value: Any) -> Mapping[str, Any]:
    if isinstance(value, str):
        parsed = json.loads(value)
        if isinstance(parsed, Mapping):
            return parsed
        raise TypeError("Job payload must decode to a JSON object.")
    if isinstance(value, Mapping):
        return value
    raise TypeError("Job payload must be a JSON object.")


def _truncate(value: str, *, max_length: int = 4000) -> str:
    if len(value) <= max_length:
        return value
    return f"{value[: max_length - 3]}..."


def run() -> None:
    """Run the default job manager forever."""
    asyncio.run(JobManager().run_forever())
