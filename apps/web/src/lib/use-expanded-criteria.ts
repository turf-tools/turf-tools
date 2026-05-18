import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { expandSegmentRefs, type SegmentLike } from "~/lib/expand-segment-refs";
import type { Criteria } from "~/lib/filters";
import { segmentsListQuery } from "~/lib/queries/segments";

// Resolves segment refs in `criteria` using the org's segments list
// (cached by TanStack). Cycle / depth errors fall through to an empty
// criteria — the editor prevents that state, this is a safety net.
export function useExpandedCriteria(criteria: Criteria | null | undefined): Criteria | null {
  const { data: segments } = useQuery(segmentsListQuery());
  return useMemo(() => {
    if (!criteria) return null;
    const map = new Map<string, SegmentLike>(
      (segments ?? []).map((s) => [
        s.segmentId,
        { segmentId: s.segmentId, name: s.name, criteria: s.criteria as Criteria },
      ]),
    );
    try {
      return expandSegmentRefs(criteria, map);
    } catch {
      return { steps: [] };
    }
  }, [criteria, segments]);
}
