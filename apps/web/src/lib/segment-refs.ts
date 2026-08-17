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

export type SegmentRefRow = {
  segmentId: string;
  updatedAt: string | Date;
  criteria: unknown;
};

// Version stamp for the segment refs reachable from `criteria`: the max
// updatedAt over the transitive closure ("" when there are none). Derived
// count queries fold this into their cache key — authored criteria is
// byte-identical when only a *referenced* segment's contents change, so
// the criteria hash alone under-keys the result.
export function segmentRefsVersion(
  criteria: unknown,
  segments: ReadonlyArray<SegmentRefRow> | undefined,
): string {
  if (!segments?.length) return "";
  const byId = new globalThis.Map(segments.map((s) => [s.segmentId, s]));
  let max = 0;
  const visited = new Set<string>();
  const visit = (c: unknown) => {
    for (const step of (c as Criteria | null | undefined)?.steps ?? []) {
      const f = step.filter;
      if (f.kind === "nested") {
        visit(f.criteria);
      } else if (f.kind === "segment" && f.segmentId != null && !visited.has(f.segmentId)) {
        visited.add(f.segmentId);
        const row = byId.get(f.segmentId);
        // Missing rows are skipped, mirroring expansion's drop-on-missing.
        if (!row) continue;
        max = Math.max(max, new Date(row.updatedAt).getTime());
        visit(row.criteria);
      }
    }
  };
  visit(criteria);
  return max ? String(max) : "";
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
