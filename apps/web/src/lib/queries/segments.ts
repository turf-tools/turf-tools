import { queryOptions } from "@tanstack/react-query";
import type { Criteria } from "~/lib/filters";
import { client } from "~/rpc/client";

export type SegmentCriteria = NonNullable<
  Awaited<ReturnType<typeof client.segments.getById>>
>["criteria"];

export const segmentsListQuery = () =>
  queryOptions({
    queryKey: ["segments"] as const,
    queryFn: () => client.segments.list(),
  });

export const segmentDetailQuery = (segmentId: string) =>
  queryOptions({
    queryKey: ["segment", segmentId] as const,
    queryFn: () => client.segments.getById({ segmentId }),
  });

// Counts + points for the segments-editor preview pane. Key-determined:
// same `effectiveKey` always yields the same result.
export const segmentPreviewQuery = (criteria: Criteria) =>
  queryOptions({
    queryKey: ["segment-preview", JSON.stringify(criteria)] as const,
    queryFn: async () => {
      const [counts, pointsBuffer] = await Promise.all([
        client.segments.count({ criteria }),
        (async () => {
          const res = await fetch("/api/segment-points", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ criteria }),
          });
          if (!res.ok) throw new Error(`segment-points failed: ${res.status} ${await res.text()}`);
          return new Float32Array(await res.arrayBuffer());
        })(),
      ]);
      return { counts, pointsBuffer };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

// Buildings inside a single zone, narrowed by segment criteria. Used by
// the turf cutter; lives here because it's a `client.segments.listBuildings`
// call. `segmentCriteria` is `unknown`-typed at the type level, so passing
// `undefined` is structurally allowed for disabled-state calls.
export const cutterBuildingsQuery = (
  zoneId: string,
  segmentCriteria: SegmentCriteria,
  keyFilter: { keyGroup: string; keys: string[] } | undefined,
) =>
  queryOptions({
    queryKey: [
      "cutter-buildings",
      zoneId,
      segmentCriteria ? JSON.stringify(segmentCriteria) : null,
    ] as const,
    queryFn: () => client.segments.listBuildings({ criteria: segmentCriteria, keyFilter }),
    staleTime: Number.POSITIVE_INFINITY,
  });
