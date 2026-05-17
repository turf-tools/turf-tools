"""Hamilton lifecycle hook for per-node timing.

Prints each node's wall time as it finishes and a sorted summary at the
end of the run. Drop-in via `Builder().with_adapters(TimingHook())`.
"""

import time
from typing import Any

from hamilton.lifecycle import NodeExecutionHook


class TimingHook(NodeExecutionHook):
    """Per-node wall-time tracker."""

    def __init__(self) -> None:
        self._start: dict[str, float] = {}
        self.timings: list[tuple[str, float, bool]] = []

    def run_before_node_execution(self, *, node_name: str, **_: Any) -> None:
        self._start[node_name] = time.time()
        print(f"  ▶ {node_name}")

    def run_after_node_execution(
        self,
        *,
        node_name: str,
        success: bool,
        **_: Any,
    ) -> None:
        elapsed = time.time() - self._start.pop(node_name, time.time())
        self.timings.append((node_name, elapsed, success))
        marker = "✓" if success else "✗"
        print(f"  {marker} {node_name}  ({elapsed:.1f}s)")

    def print_summary(self) -> None:
        if not self.timings:
            return
        total = sum(t for _, t, _ in self.timings)
        ranked = sorted(self.timings, key=lambda r: r[1], reverse=True)
        print("\nNode timing summary (slowest first):")
        for name, elapsed, ok in ranked:
            pct = 100.0 * elapsed / total if total else 0.0
            marker = " " if ok else "✗"
            print(f"  {marker} {elapsed:7.1f}s  {pct:5.1f}%   {name}")
        print(f"  {'':1} {total:7.1f}s  100.0%   (total node time)")
