import type { Criteria } from "~/lib/filters";

// Client-side cycle detection for segment refs. Resolution of refs to
// `NestedFilter` lives in Python on the data server — see
// `apps/data/src/dsl/expand.py`. The two functions here serve UI/
// save-time concerns that don't go through the data server:
//
// - `findCyclicSegmentIds` powers the segment-ref dropdown (which
//   choices would create a cycle if selected from a given segment).
// - `detectSegmentCycles` is the save-time backstop in `updateCriteria`
//   to refuse persisting cyclic criteria.

export class SegmentRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentRefError";
  }
}

export type SegmentLike = { segmentId: string; name: string; criteria: Criteria };

// Throws if `incoming` (the criteria being saved for `selfId`) would
// create a cycle given the org's other segments. Walks segment refs in
// `incoming` and follows each through `otherSegments`; a path back to
// `selfId` is a cycle.
export function detectSegmentCycles(
  selfId: string,
  incoming: Criteria,
  otherSegments: ReadonlyMap<string, SegmentLike>,
): void {
  for (const step of incoming.steps) {
    const f = step.filter;
    if (f.kind !== "segment" || f.segmentId == null) continue;
    if (f.segmentId === selfId) {
      throw new SegmentRefError("Segment cannot reference itself");
    }
    walk(f.segmentId, new Set([selfId]), otherSegments);
  }
}

function walk(
  id: string,
  visiting: Set<string>,
  segmentsById: ReadonlyMap<string, SegmentLike>,
): void {
  if (visiting.has(id)) {
    throw new SegmentRefError(`Segment reference cycle through ${id}`);
  }
  const seg = segmentsById.get(id);
  if (!seg) return;
  const next = new Set(visiting);
  next.add(id);
  for (const step of seg.criteria.steps) {
    const f = step.filter;
    if (f.kind !== "segment" || f.segmentId == null) continue;
    walk(f.segmentId, next, segmentsById);
  }
}

// Returns the ids that would form a cycle if added to the chain
// ending in `targetId`. Used by the editor to disable cyclic choices
// in the dropdown.
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
