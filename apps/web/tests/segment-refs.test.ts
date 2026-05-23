import { test, expect } from "vite-plus/test";
import type { Criteria } from "../src/lib/filters";
import {
  detectSegmentCycles,
  findCyclicSegmentIds,
  SegmentRefError,
  type SegmentLike,
} from "../src/lib/segment-refs";

const seg = (segmentId: string, name: string, criteria: Criteria): SegmentLike => ({
  segmentId,
  name,
  criteria,
});

function mapOf(...segments: SegmentLike[]): ReadonlyMap<string, SegmentLike> {
  return new Map(segments.map((s) => [s.segmentId, s]));
}

test("detectSegmentCycles allows a non-cyclic save", () => {
  const a = seg("a", "A", {
    steps: [
      { id: "s1", verb: "narrow", filter: { kind: "text", key: "first_name", value: "Joe" } },
    ],
  });
  const incoming: Criteria = {
    steps: [
      { id: "x", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "a" } },
    ],
  };
  // No throw.
  detectSegmentCycles("self", incoming, mapOf(a));
});

test("detectSegmentCycles flags direct self-reference", () => {
  const incoming: Criteria = {
    steps: [
      { id: "x", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "self" } },
    ],
  };
  expect(() => detectSegmentCycles("self", incoming, mapOf())).toThrow(SegmentRefError);
});

test("detectSegmentCycles flags an indirect cycle (self -> A -> self)", () => {
  const a = seg("a", "A", {
    steps: [
      { id: "s1", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "self" } },
    ],
  });
  const incoming: Criteria = {
    steps: [
      { id: "x", verb: "narrow", filter: { kind: "segment", key: "segment", segmentId: "a" } },
    ],
  };
  expect(() => detectSegmentCycles("self", incoming, mapOf(a))).toThrow(SegmentRefError);
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
