import { test, expect } from "vite-plus/test";
import type { Criteria } from "../src/lib/filters";
import {
  expandSegmentRefs,
  findCyclicSegmentIds,
  SegmentRefError,
  type SegmentLike,
} from "../src/lib/expand-segment-refs";

const seg = (segmentId: string, name: string, criteria: Criteria): SegmentLike => ({
  segmentId,
  name,
  criteria,
});

function mapOf(...segments: SegmentLike[]): ReadonlyMap<string, SegmentLike> {
  return new Map(segments.map((s) => [s.segmentId, s]));
}

test("expands a SegmentFilter to a NestedFilter inline", () => {
  const a = seg("a", "A", {
    steps: [
      {
        id: "s1",
        verb: "narrow",
        filter: { kind: "text", key: "first_name", value: "Joe" },
      },
    ],
  });
  const outer: Criteria = {
    steps: [
      { id: "x", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "a" } },
    ],
  };
  const expanded = expandSegmentRefs(outer, mapOf(a));
  expect(expanded.steps[0]!.filter).toEqual({
    kind: "nested",
    criteria: a.criteria,
  });
});

test("expands nested references recursively", () => {
  const a = seg("a", "A", {
    steps: [
      { id: "s1", verb: "narrow", filter: { kind: "text", key: "first_name", value: "Joe" } },
    ],
  });
  const b = seg("b", "B", {
    steps: [
      { id: "s2", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "a" } },
    ],
  });
  const outer: Criteria = {
    steps: [
      { id: "x", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "b" } },
    ],
  };
  const expanded = expandSegmentRefs(outer, mapOf(a, b));
  const outerNested = expanded.steps[0]!.filter;
  expect(outerNested.kind).toBe("nested");
  if (outerNested.kind !== "nested") throw new Error("unreachable");
  const innerNested = outerNested.criteria.steps[0]!.filter;
  expect(innerNested).toEqual({ kind: "nested", criteria: a.criteria });
});

test("detects a direct cycle (A -> A)", () => {
  const a = seg("a", "A", {
    steps: [
      { id: "s1", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "a" } },
    ],
  });
  const outer: Criteria = {
    steps: [
      { id: "x", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "a" } },
    ],
  };
  expect(() => expandSegmentRefs(outer, mapOf(a))).toThrow(SegmentRefError);
});

test("detects an indirect cycle (A -> B -> A)", () => {
  const a = seg("a", "A", {
    steps: [
      { id: "s1", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "b" } },
    ],
  });
  const b = seg("b", "B", {
    steps: [
      { id: "s2", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "a" } },
    ],
  });
  const outer: Criteria = {
    steps: [
      { id: "x", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "a" } },
    ],
  };
  expect(() => expandSegmentRefs(outer, mapOf(a, b))).toThrow(SegmentRefError);
});

test("missing referenced segment is dropped from criteria", () => {
  const outer: Criteria = {
    steps: [
      { id: "x", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "ghost" } },
    ],
  };
  const expanded = expandSegmentRefs(outer, mapOf());
  expect(expanded.steps).toEqual([]);
});

test("null segmentId is dropped from criteria", () => {
  const outer: Criteria = {
    steps: [
      { id: "x", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: null } },
    ],
  };
  const expanded = expandSegmentRefs(outer, mapOf());
  expect(expanded.steps).toEqual([]);
});

test("depth cap fires on long chains", () => {
  // Chain of 10 segments, each referencing the next. Exceeds MAX_DEPTH=8.
  const segments: SegmentLike[] = [];
  for (let i = 0; i < 10; i++) {
    const next = i < 9 ? `s${i + 1}` : null;
    segments.push(
      seg(`s${i}`, `S${i}`, {
        steps:
          next == null
            ? [
                {
                  id: `f${i}`,
                  verb: "narrow",
                  filter: { kind: "text", key: "first_name", value: "x" },
                },
              ]
            : [
                {
                  id: `f${i}`,
                  verb: "narrow",
                  filter: { kind: "segment", key: "segment", segmentId: next },
                },
              ],
      }),
    );
  }
  const outer: Criteria = {
    steps: [
      { id: "x", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "s0" } },
    ],
  };
  expect(() => expandSegmentRefs(outer, mapOf(...segments))).toThrow(SegmentRefError);
});

test("leaves non-segment filters untouched", () => {
  const outer: Criteria = {
    steps: [
      { id: "x", verb: "narrow", filter: { kind: "text", key: "first_name", value: "Joe" } },
      {
        id: "y",
        verb: "add",
        filter: { kind: "enum", key: "enrollment", values: ["democratic"] },
      },
    ],
  };
  expect(expandSegmentRefs(outer, mapOf())).toEqual(outer);
});

test("findCyclicSegmentIds reports self + transitive ancestors", () => {
  // A -> B -> C. From C's editor, picking A or B (or C) would cycle.
  const a = seg("a", "A", {
    steps: [
      { id: "s1", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "b" } },
    ],
  });
  const b = seg("b", "B", {
    steps: [
      { id: "s2", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "c" } },
    ],
  });
  const c = seg("c", "C", { steps: [] });
  const d = seg("d", "D", { steps: [] });
  const cyclic = findCyclicSegmentIds("c", mapOf(a, b, c, d));
  expect([...cyclic].sort()).toEqual(["a", "b", "c"]);
});
