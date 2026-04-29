import { queryOptions } from "@tanstack/react-query";
import type { Query } from "~/lib/filters";
import { client } from "~/rpc/client";

export type SegmentQuery = NonNullable<
  Awaited<ReturnType<typeof client.segments.getById>>
>["query"];

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
export const queryPreviewQuery = (query: Query) =>
  queryOptions({
    queryKey: ["query-preview", JSON.stringify(query)] as const,
    queryFn: async () => {
      const [counts, pointsBuffer] = await Promise.all([
        client.segments.queryCounts({ query }),
        (async () => {
          const res = await fetch("/api/query-points", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query }),
          });
          if (!res.ok) throw new Error(`query-points failed: ${res.status} ${await res.text()}`);
          return new Float32Array(await res.arrayBuffer());
        })(),
      ]);
      return { counts, pointsBuffer };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

// Buildings inside a single zone, narrowed by a segment query. Used by the
// turf cutter; lives here because it's a `client.segments.queryBuildings`
// call. `segmentQuery` is typed as `SegmentQuery` (which is `unknown`),
// so passing `undefined` is structurally allowed for disabled-state calls.
export const cutterBuildingsQuery = (
  zoneId: string,
  segmentQuery: SegmentQuery,
  keyFilter: { keyGroup: string; keys: string[] } | undefined,
) =>
  queryOptions({
    queryKey: [
      "cutter-buildings",
      zoneId,
      segmentQuery ? JSON.stringify(segmentQuery) : null,
    ] as const,
    queryFn: () => client.segments.queryBuildings({ query: segmentQuery, keyFilter }),
    staleTime: Number.POSITIVE_INFINITY,
  });
