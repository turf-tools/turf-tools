"""Per-request phase timings, surfaced as a `Server-Timing` response header.

The middleware in `main.py` opens a request scope; anything on the call path
wraps its work in `timed("phase")`. Browsers render the header natively in the
Network panel, so the resolve/catalog/criteria/query split is visible against
any deployment with no extra tooling.
"""

from __future__ import annotations

import time
from contextlib import contextmanager
from contextvars import ContextVar

_phases: ContextVar[dict[str, float] | None] = ContextVar("server_timing_phases", default=None)


def start_request() -> None:
    _phases.set({})


@contextmanager
def timed(name: str):
    t0 = time.perf_counter()
    try:
        yield
    finally:
        phases = _phases.get()
        if phases is not None:
            phases[name] = phases.get(name, 0.0) + (time.perf_counter() - t0) * 1000


def header_value(total_ms: float) -> str:
    phases = _phases.get() or {}
    parts = [f"{name};dur={ms:.1f}" for name, ms in phases.items()]
    parts.append(f"total;dur={total_ms:.1f}")
    return ", ".join(parts)
