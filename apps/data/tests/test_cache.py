"""singleflight_lru (src.cache): fill dedupe, byte budget, oversized
values, and recovery from a failed fill."""

from __future__ import annotations

import threading
import time

from src.cache import singleflight_lru


def counted(fn):
    calls: list[tuple] = []

    def wrapper(*args):
        calls.append(args)
        return fn(*args)

    wrapper.calls = calls
    return wrapper


def test_concurrent_identical_calls_compute_once() -> None:
    compute = counted(lambda conn, k: (time.sleep(0.05), f"value-{k}")[1])
    cached_fn = singleflight_lru(1024, sizeof=len, key=lambda conn, k: k)(compute)

    results: list[str] = []
    threads = [threading.Thread(target=lambda i=i: results.append(cached_fn(f"conn{i}", "a"))) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert results == ["value-a"] * 8
    assert len(compute.calls) == 1


def test_distinct_keys_compute_independently() -> None:
    compute = counted(lambda conn, k: f"value-{k}")
    cached_fn = singleflight_lru(1024, sizeof=len, key=lambda conn, k: k)(compute)

    assert cached_fn(None, "a") == "value-a"
    assert cached_fn(None, "b") == "value-b"
    assert cached_fn(None, "a") == "value-a"
    assert len(compute.calls) == 2


def test_byte_budget_evicts_least_recently_used() -> None:
    compute = counted(lambda k: k * 4)
    cached_fn = singleflight_lru(10, sizeof=len, key=lambda k: k)(compute)

    cached_fn("a")  # 4 bytes
    cached_fn("b")  # 8 bytes
    cached_fn("a")  # refresh "a"
    cached_fn("c")  # 12 bytes: evicts "b"
    cached_fn("a")  # still cached
    cached_fn("b")  # recomputed

    assert [c[0] for c in compute.calls] == ["a", "b", "c", "b"]


def test_value_over_budget_served_uncached() -> None:
    compute = counted(lambda k: k * 100)
    cached_fn = singleflight_lru(10, sizeof=len, key=lambda k: k)(compute)

    assert cached_fn("a") == "a" * 100
    assert cached_fn("a") == "a" * 100
    assert len(compute.calls) == 2


def test_failed_fill_wakes_waiters_and_is_not_cached() -> None:
    attempts: list[int] = []

    def flaky(k: str) -> str:
        attempts.append(len(attempts))
        if len(attempts) == 1:
            time.sleep(0.05)
            raise RuntimeError("boom")
        return f"value-{k}"

    cached_fn = singleflight_lru(1024, sizeof=len, key=lambda k: k)(flaky)

    errors: list[Exception] = []

    def first():
        try:
            cached_fn("a")
        except RuntimeError as e:
            errors.append(e)

    t1 = threading.Thread(target=first)
    t1.start()
    time.sleep(0.01)  # let t1 enter the fill before the second call
    assert cached_fn("a") == "value-a"
    t1.join()

    assert len(errors) == 1
    assert len(attempts) == 2
    assert cached_fn("a") == "value-a"
    assert len(attempts) == 2


def test_sizeof_none_guard() -> None:
    cached_fn = singleflight_lru(10, sizeof=lambda v: len(v) if v else 1, key=lambda k: k)(lambda k: None)
    assert cached_fn("a") is None
    assert cached_fn("a") is None
