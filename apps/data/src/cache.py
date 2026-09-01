"""Process-wide caches for expensive pure query results."""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any

from cachetools import LRUCache, cached

if TYPE_CHECKING:
    from collections.abc import Callable


def singleflight_lru(
    max_bytes: int,
    *,
    sizeof: Callable[[Any], int],
    key: Callable[..., Any],
):
    """Byte-budgeted LRU memoization with single-flight fill.

    Concurrent calls that map to the same key wait for the one already
    computing instead of recomputing; a failed fill wakes the waiters,
    which retry. A value larger than the whole budget is served but not
    stored. Keys must fold in everything the result depends on — there
    is no invalidation.
    """
    return cached(
        cache=LRUCache(maxsize=max_bytes, getsizeof=sizeof),
        key=key,
        # A bare Condition doubles as the cache lock.
        condition=threading.Condition(),
    )
