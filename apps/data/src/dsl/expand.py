"""Resolve `SegmentFilter` references in a criteria tree by inlining the
referenced segment's criteria as a `NestedFilter`. Called once per
criteria-receiving endpoint before `criteria_to_where` — the SQL compiler
never sees a `SegmentFilter`.

Throws on cycles and on nesting deeper than `MAX_DEPTH`. References to
missing or null segment ids are dropped from the output entirely:
inlining them as empty `NestedFilter`s would let the compiler interpret
them as "match universe", which is destructive for `add` (becomes
everyone) and `remove` (empties the set). Dropping makes a broken
reference indistinguishable from "step doesn't exist".
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from .criteria import Criteria, NestedFilter, SegmentFilter, Step

if TYPE_CHECKING:
    from collections.abc import Mapping

MAX_DEPTH = 8


class SegmentRefError(ValueError):
    def __init__(self, message: str, kind: Literal["cycle", "depth"]) -> None:
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class SegmentLike:
    segment_id: str
    name: str
    criteria: Criteria


def expand_segment_refs(criteria: Criteria, segments_by_id: Mapping[str, SegmentLike]) -> Criteria:
    return _expand(criteria, segments_by_id, frozenset(), 0)


def _expand(
    criteria: Criteria,
    segments_by_id: Mapping[str, SegmentLike],
    visiting: frozenset[str],
    depth: int,
) -> Criteria:
    if depth > MAX_DEPTH:
        raise SegmentRefError(f"Segment nesting deeper than {MAX_DEPTH}", "depth")
    new_steps: list[Step] = []
    for step in criteria.steps:
        f = step.filter
        if not isinstance(f, SegmentFilter):
            new_steps.append(step)
            continue
        seg_id = f.segment_id
        if seg_id is None:
            continue
        if seg_id in visiting:
            raise SegmentRefError(f"Segment reference cycle through {seg_id}", "cycle")
        referenced = segments_by_id.get(seg_id)
        if referenced is None:
            continue
        inner = _expand(referenced.criteria, segments_by_id, visiting | {seg_id}, depth + 1)
        new_steps.append(Step(verb=step.verb, filter=NestedFilter(kind="nested", criteria=inner)))
    return Criteria(steps=new_steps)
