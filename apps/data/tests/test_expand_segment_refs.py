"""Port of apps/web/tests/expand-segment-refs.test.ts. Same cases, same
expected behavior. Kept in lockstep with the TS suite (now removed —
expansion lives in Python only)."""

from __future__ import annotations

import pytest

from src.dsl.criteria import (
    Criteria,
    EnumFilter,
    NestedFilter,
    SegmentFilter,
    Step,
    TextFilter,
)
from src.dsl.expand import (
    SegmentLike,
    SegmentRefError,
    expand_segment_refs,
)


def _seg(segment_id: str, name: str, criteria: Criteria) -> SegmentLike:
    return SegmentLike(segment_id=segment_id, name=name, criteria=criteria)


def _map(*segments: SegmentLike) -> dict[str, SegmentLike]:
    return {s.segment_id: s for s in segments}


def _ref(segment_id: str | None) -> SegmentFilter:
    return SegmentFilter(kind="segment", segment_id=segment_id)


def test_expands_a_segment_filter_to_a_nested_filter_inline() -> None:
    a = _seg(
        "a",
        "A",
        Criteria(steps=[Step(verb="narrow", filter=TextFilter(kind="text", key="first_name", value="Joe"))]),
    )
    outer = Criteria(steps=[Step(verb="narrow", filter=_ref("a"))])
    expanded = expand_segment_refs(outer, _map(a))
    assert expanded.steps[0].filter == NestedFilter(kind="nested", criteria=a.criteria)


def test_expands_nested_references_recursively() -> None:
    a = _seg(
        "a",
        "A",
        Criteria(steps=[Step(verb="narrow", filter=TextFilter(kind="text", key="first_name", value="Joe"))]),
    )
    b = _seg("b", "B", Criteria(steps=[Step(verb="narrow", filter=_ref("a"))]))
    outer = Criteria(steps=[Step(verb="narrow", filter=_ref("b"))])
    expanded = expand_segment_refs(outer, _map(a, b))
    outer_nested = expanded.steps[0].filter
    assert isinstance(outer_nested, NestedFilter)
    inner_nested = outer_nested.criteria.steps[0].filter
    assert inner_nested == NestedFilter(kind="nested", criteria=a.criteria)


def test_detects_a_direct_cycle() -> None:
    a = _seg("a", "A", Criteria(steps=[Step(verb="narrow", filter=_ref("a"))]))
    outer = Criteria(steps=[Step(verb="narrow", filter=_ref("a"))])
    with pytest.raises(SegmentRefError) as exc_info:
        expand_segment_refs(outer, _map(a))
    assert exc_info.value.kind == "cycle"


def test_detects_an_indirect_cycle() -> None:
    a = _seg("a", "A", Criteria(steps=[Step(verb="narrow", filter=_ref("b"))]))
    b = _seg("b", "B", Criteria(steps=[Step(verb="narrow", filter=_ref("a"))]))
    outer = Criteria(steps=[Step(verb="narrow", filter=_ref("a"))])
    with pytest.raises(SegmentRefError) as exc_info:
        expand_segment_refs(outer, _map(a, b))
    assert exc_info.value.kind == "cycle"


def test_missing_referenced_segment_is_dropped() -> None:
    outer = Criteria(steps=[Step(verb="narrow", filter=_ref("ghost"))])
    expanded = expand_segment_refs(outer, _map())
    assert expanded.steps == []


def test_null_segment_id_is_dropped() -> None:
    outer = Criteria(steps=[Step(verb="narrow", filter=_ref(None))])
    expanded = expand_segment_refs(outer, _map())
    assert expanded.steps == []


def test_depth_cap_fires_on_long_chains() -> None:
    # Chain of 10 segments, each referencing the next. Exceeds MAX_DEPTH=8.
    segments: list[SegmentLike] = []
    for i in range(10):
        next_id: str | None = f"s{i + 1}" if i < 9 else None
        inner_filter = TextFilter(kind="text", key="first_name", value="x") if next_id is None else _ref(next_id)
        segments.append(_seg(f"s{i}", f"S{i}", Criteria(steps=[Step(verb="narrow", filter=inner_filter)])))
    outer = Criteria(steps=[Step(verb="narrow", filter=_ref("s0"))])
    with pytest.raises(SegmentRefError) as exc_info:
        expand_segment_refs(outer, _map(*segments))
    assert exc_info.value.kind == "depth"


def test_leaves_non_segment_filters_untouched() -> None:
    outer = Criteria(
        steps=[
            Step(verb="narrow", filter=TextFilter(kind="text", key="first_name", value="Joe")),
            Step(verb="add", filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
        ],
    )
    assert expand_segment_refs(outer, _map()) == outer


def test_resolve_criteria_resolves_canvass_filter_hidden_behind_ref(monkeypatch) -> None:
    # A canvass leaf visible only behind a ref must still resolve — the
    # pre-expansion needs_canvass check can't see it.
    from src.dsl import resolve
    from src.dsl.criteria import CanvassOutcomeFilter, PersonIdSetFilter

    monkeypatch.setattr(resolve, "attach_operational_postgres", lambda conn, settings: None)
    canvass = CanvassOutcomeFilter(kind="canvass-outcome", outcomes=["canvassed"])
    canvass_seg = _seg("a", "A", Criteria(steps=[Step(verb="narrow", filter=canvass)]))
    monkeypatch.setattr(resolve, "_load_segments_for_org", lambda conn, org: _map(canvass_seg))
    monkeypatch.setattr(resolve, "_canvass_outcome_person_ids", lambda conn, org, outcomes: ["p1"])

    outer = Criteria(steps=[Step(verb="narrow", filter=_ref("a"))])
    resolved = resolve.resolve_criteria(outer, conn=None, settings=None, org_slug="org")

    nested = resolved.steps[0].filter
    assert isinstance(nested, NestedFilter)
    assert nested.criteria.steps[0].filter == PersonIdSetFilter(kind="person-id-set", ids=["p1"])
