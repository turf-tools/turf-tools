import type { Criteria, Step } from "~/lib/filters";

// Resolves SegmentFilter references in a criteria tree by inlining the
// referenced segment's criteria as a NestedFilter. The data server never
// sees segment ids — only nested criteria, which it compiles as a
// parenthesized boolean expression.
//
// Throws on cycles and on nesting deeper than MAX_DEPTH. References to
// missing or null segment ids are dropped from the output entirely
// (see the comment in `expand` for why).

const MAX_DEPTH = 8;

export class SegmentRefError extends Error {
  readonly kind: "cycle" | "depth";
  constructor(message: string, kind: "cycle" | "depth") {
    super(message);
    this.name = "SegmentRefError";
    this.kind = kind;
  }
}

export type SegmentLike = { segmentId: string; name: string; criteria: Criteria };

export function expandSegmentRefs(
  criteria: Criteria,
  segmentsById: ReadonlyMap<string, SegmentLike>,
): Criteria {
  return expand(criteria, segmentsById, new Set(), 0);
}

// Returns the ids that would form a cycle if added to the chain
// ending in `targetId`. Used by the editor to disable cyclic choices
// in the dropdown. Walks transitively via segment refs in stored
// criteria.
export function findCyclicSegmentIds(
  targetId: string,
  segmentsById: ReadonlyMap<string, SegmentLike>,
): Set<string> {
  const result = new Set<string>();
  for (const id of segmentsById.keys()) {
    if (id === targetId) {
      result.add(id);
      continue;
    }
    if (referencesTransitively(id, targetId, segmentsById, new Set())) {
      result.add(id);
    }
  }
  return result;
}

function expand(
  criteria: Criteria,
  segmentsById: ReadonlyMap<string, SegmentLike>,
  visiting: Set<string>,
  depth: number,
): Criteria {
  if (depth > MAX_DEPTH) {
    throw new SegmentRefError(`Segment nesting deeper than ${MAX_DEPTH}`, "depth");
  }
  // Steps referencing a missing or null segment are dropped entirely.
  // Inlining them as empty NestedFilters would let the data server
  // interpret them as "match universe" — fine for `narrow`, destructive
  // for `add` (becomes everyone) and `remove` (empties the set).
  // Dropping makes a broken reference indistinguishable from "step
  // doesn't exist", which is the least-surprising no-op.
  const steps: Step[] = [];
  for (const step of criteria.steps) {
    const f = step.filter;
    if (f.kind !== "segment") {
      steps.push(step);
      continue;
    }
    const id = f.segmentId;
    if (id == null) continue;
    if (visiting.has(id)) {
      throw new SegmentRefError(`Segment reference cycle through ${id}`, "cycle");
    }
    const referenced = segmentsById.get(id);
    if (!referenced) continue;
    const next = new Set(visiting);
    next.add(id);
    const inner = expand(referenced.criteria, segmentsById, next, depth + 1);
    steps.push({ ...step, filter: { kind: "nested", criteria: inner } });
  }
  return { steps };
}

function referencesTransitively(
  fromId: string,
  toId: string,
  segmentsById: ReadonlyMap<string, SegmentLike>,
  visited: Set<string>,
): boolean {
  if (visited.has(fromId)) return false;
  visited.add(fromId);
  const seg = segmentsById.get(fromId);
  if (!seg) return false;
  for (const step of seg.criteria.steps) {
    const f = step.filter;
    if (f.kind !== "segment" || f.segmentId == null) continue;
    if (f.segmentId === toId) return true;
    if (referencesTransitively(f.segmentId, toId, segmentsById, visited)) return true;
  }
  return false;
}
