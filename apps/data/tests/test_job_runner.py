from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import pytest
from pydantic import BaseModel

from src.job_runner import (
    COMPLETED,
    IN_PROGRESS,
    PERMANENTLY_FAILED,
    UNSTARTED,
    ClaimedJob,
    JobContext,
    JobManager,
    JobRegistry,
    job,
)

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping


class Payload(BaseModel):
    name: str
    count: int = 1


@dataclass
class StoredJob:
    job_id: uuid.UUID
    task: str
    payload: dict[str, Any]
    concurrency_key: str | None = None
    status: str = UNSTARTED
    result: Any = None
    failure_reason: str | None = None
    locked_by_worker_id: str | None = None
    messages: list[dict[str, Any]] = field(default_factory=list)


class MemoryJobStore:
    def __init__(self, jobs: list[StoredJob]) -> None:
        self.jobs = jobs

    async def claim_jobs(self, *, worker_id: str, tasks: Iterable[str], limit: int) -> list[ClaimedJob]:
        claimed: list[ClaimedJob] = []
        claimed_keys: set[str] = set()
        task_set = set(tasks)

        for stored_job in self.jobs:
            if len(claimed) >= limit:
                break
            if stored_job.status != UNSTARTED or stored_job.task not in task_set:
                continue

            key = stored_job.concurrency_key
            active_same_key = key is not None and any(
                other.status == IN_PROGRESS and other.concurrency_key == key for other in self.jobs
            )
            if active_same_key or (key is not None and key in claimed_keys):
                continue

            stored_job.status = IN_PROGRESS
            stored_job.locked_by_worker_id = worker_id
            if key is not None:
                claimed_keys.add(key)
            claimed.append(
                ClaimedJob(
                    job_id=stored_job.job_id,
                    task=stored_job.task,
                    payload=stored_job.payload,
                    concurrency_key=stored_job.concurrency_key,
                )
            )

        return claimed

    async def complete_job(self, *, job_id: uuid.UUID, result: Any) -> None:
        stored_job = self._job(job_id)
        stored_job.status = COMPLETED
        stored_job.result = result
        stored_job.failure_reason = None
        stored_job.locked_by_worker_id = None

    async def fail_job(self, *, job_id: uuid.UUID, failure_reason: str) -> None:
        stored_job = self._job(job_id)
        stored_job.status = PERMANENTLY_FAILED
        stored_job.failure_reason = failure_reason
        stored_job.locked_by_worker_id = None

    async def write_message(self, *, job_id: uuid.UUID, payload: Mapping[str, Any]) -> None:
        self._job(job_id).messages.append(dict(payload))

    def _job(self, job_id: uuid.UUID) -> StoredJob:
        for stored_job in self.jobs:
            if stored_job.job_id == job_id:
                return stored_job
        raise KeyError(job_id)


def test_job_decorator_registers_function_with_inferred_payload_model() -> None:
    registry = JobRegistry()

    @job(registry=registry)
    def example(payload: Payload, ctx: JobContext) -> dict[str, Any]:
        return {"name": payload.name, "worker": ctx.worker_id}

    registered = registry.get("example")

    assert registered is not None
    assert registered.func is example
    assert registered.payload_model is Payload


def test_run_once_completes_successful_job_and_writes_messages() -> None:
    registry = JobRegistry()

    @job(registry=registry)
    async def example(payload: Payload, ctx: JobContext) -> dict[str, Any]:
        await ctx.message("started", count=payload.count)
        await ctx.message({"phase": "done"})
        return {"greeting": f"hello {payload.name}"}

    stored_job = StoredJob(job_id=uuid.uuid4(), task="example", payload={"name": "Ada", "count": 3})
    store = MemoryJobStore([stored_job])

    handled = asyncio.run(JobManager(registry=registry, store=store, worker_id="worker-1").run_once())

    assert handled == 1
    assert stored_job.status == COMPLETED
    assert stored_job.result == {"greeting": "hello Ada"}
    assert stored_job.locked_by_worker_id is None
    assert stored_job.messages == [
        {"level": "info", "message": "started", "count": 3},
        {"level": "info", "phase": "done"},
    ]


def test_run_once_supports_payload_only_job_functions() -> None:
    registry = JobRegistry()

    @job(registry=registry)
    def example(payload: Payload) -> dict[str, Any]:
        return {"name": payload.name}

    stored_job = StoredJob(job_id=uuid.uuid4(), task="example", payload={"name": "Ada"})
    store = MemoryJobStore([stored_job])

    handled = asyncio.run(JobManager(registry=registry, store=store).run_once())

    assert handled == 1
    assert stored_job.status == COMPLETED
    assert stored_job.result == {"name": "Ada"}


def test_run_once_marks_validation_errors_permanently_failed() -> None:
    registry = JobRegistry()

    @job(registry=registry)
    def example(payload: Payload, ctx: JobContext) -> None:
        raise AssertionError("job function should not run")

    stored_job = StoredJob(job_id=uuid.uuid4(), task="example", payload={"count": 3})
    store = MemoryJobStore([stored_job])

    handled = asyncio.run(JobManager(registry=registry, store=store).run_once())

    assert handled == 1
    assert stored_job.status == PERMANENTLY_FAILED
    assert "name" in (stored_job.failure_reason or "")
    assert stored_job.messages[0]["message"] == "Job payload validation failed."
    assert stored_job.messages[0]["level"] == "error"


def test_run_once_marks_exceptions_permanently_failed() -> None:
    registry = JobRegistry()

    @job(registry=registry)
    def example(payload: Payload, ctx: JobContext) -> None:
        raise RuntimeError(f"boom {payload.name}")

    stored_job = StoredJob(job_id=uuid.uuid4(), task="example", payload={"name": "Ada"})
    store = MemoryJobStore([stored_job])

    handled = asyncio.run(JobManager(registry=registry, store=store).run_once())

    assert handled == 1
    assert stored_job.status == PERMANENTLY_FAILED
    assert stored_job.failure_reason == "boom Ada"
    assert stored_job.messages[0]["level"] == "error"
    assert stored_job.messages[0]["exception_type"] == "RuntimeError"
    assert "Traceback" in stored_job.messages[0]["traceback"]


def test_run_once_claims_only_one_job_per_active_concurrency_key() -> None:
    registry = JobRegistry()
    seen: list[str] = []

    @job(registry=registry)
    def example(payload: Payload, ctx: JobContext) -> dict[str, Any]:
        seen.append(payload.name)
        return {"name": payload.name}

    jobs = [
        StoredJob(job_id=uuid.uuid4(), task="example", payload={"name": "first"}, concurrency_key="same-key"),
        StoredJob(job_id=uuid.uuid4(), task="example", payload={"name": "second"}, concurrency_key="same-key"),
        StoredJob(job_id=uuid.uuid4(), task="example", payload={"name": "third"}, concurrency_key="other-key"),
    ]
    store = MemoryJobStore(jobs)
    manager = JobManager(registry=registry, store=store, max_concurrent_jobs=3)

    handled = asyncio.run(manager.run_once())

    assert handled == 2
    assert seen == ["first", "third"]
    assert jobs[0].status == COMPLETED
    assert jobs[1].status == UNSTARTED
    assert jobs[2].status == COMPLETED


def test_run_once_skips_jobs_with_already_active_concurrency_key() -> None:
    registry = JobRegistry()

    @job(registry=registry)
    def example(payload: Payload, ctx: JobContext) -> dict[str, Any]:
        return {"name": payload.name}

    active = StoredJob(
        job_id=uuid.uuid4(),
        task="example",
        payload={"name": "active"},
        concurrency_key="same-key",
        status=IN_PROGRESS,
    )
    blocked = StoredJob(job_id=uuid.uuid4(), task="example", payload={"name": "blocked"}, concurrency_key="same-key")
    runnable = StoredJob(job_id=uuid.uuid4(), task="example", payload={"name": "runnable"}, concurrency_key=None)
    store = MemoryJobStore([active, blocked, runnable])

    handled = asyncio.run(JobManager(registry=registry, store=store, max_concurrent_jobs=3).run_once())

    assert handled == 1
    assert active.status == IN_PROGRESS
    assert blocked.status == UNSTARTED
    assert runnable.status == COMPLETED


def test_job_requires_payload_model_annotation() -> None:
    registry = JobRegistry()

    with pytest.raises(TypeError, match="Pydantic payload model"):

        @job(registry=registry)
        def example(payload: dict[str, Any], ctx: JobContext) -> None:
            return None
