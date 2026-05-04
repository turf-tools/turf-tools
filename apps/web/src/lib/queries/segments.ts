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
// same criteria always yields the same result.
export const segmentPreviewQuery = (criteria: Criteria) =>
  queryOptions({
    queryKey: ["segment-preview", JSON.stringify(criteria)] as const,
    queryFn: async () => {
      const [counts, pointsBuffer] = await Promise.all([
        client.segments.count({ criteria }),
        fetchSegmentPoints({ criteria }),
      ]);
      return { counts, pointsBuffer };
    },
    staleTime: Number.POSITIVE_INFINITY,
    // Releases the multi-MB Float32Array buffer the moment the query
    // goes inactive — accumulating multiple in cache triggers V8 GC
    // pauses on subsequent navigations.
    gcTime: 0,
  });

// Binary lng/lat pairs — uploaded directly into a GPU buffer, so the
// response stays as raw bytes the whole way through (no JSON envelope,
// no per-byte JS decode). Lives outside oRPC for that reason; auth /
// org are enforced by the /api proxy on the web edge.
export async function fetchSegmentPoints(input: {
  criteria: unknown;
  keyFilter?: { keyGroup: string; keys: string[] } | null;
}): Promise<Float32Array> {
  const res = await fetch("/api/segment-points", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      criteria: input.criteria,
      keyFilter: input.keyFilter,
    }),
  });
  if (!res.ok) throw new Error(`segment-points failed: ${res.status} ${await res.text()}`);
  return new Float32Array(await res.arrayBuffer());
}

// Buildings inside a single zone, narrowed by segment criteria. Used
// by the turf cutter. `segmentCriteria` is `unknown`-typed at the type
// level, so passing `undefined` is structurally allowed for
// disabled-state calls.
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
    queryFn: () =>
      client.segments.listBuildings({
        criteria: segmentCriteria,
        keyFilter,
      }),
    staleTime: Number.POSITIVE_INFINITY,
  });
