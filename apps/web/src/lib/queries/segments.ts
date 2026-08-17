import { queryOptions } from "@tanstack/react-query";
import { getCurrentOrgSlug } from "~/lib/current-route";
import { criteriaTouchesLiveData, type Criteria } from "~/lib/filters";
import { segmentRefsVersion, type SegmentRefRow } from "~/lib/segment-refs";
import { client } from "~/rpc/client";

export type SegmentCriteria = NonNullable<
  Awaited<ReturnType<typeof client.segments.getById>>
>["criteria"];

// The org segments list, threaded into every derived query for two reasons:
// segment refs make the criteria hash alone an incomplete cache key (see
// `segmentRefsVersion`), and a ref can reach live canvass leaves that the
// authored criteria doesn't show (see `criteriaTouchesLiveData`).
export type SegmentRows = ReadonlyArray<SegmentRefRow> | undefined;

// `staleTime: Infinity` only holds for criteria that are pure functions of the
// key; canvass leaves read live data and drift, so they fall back to the
// default. `unknown` arg so loosely-typed `SegmentCriteria` callers pass through
// without casts. See `criteriaTouchesLiveData`.
export function liveAwareStaleTime(criteria: unknown, segments: SegmentRows): number | undefined {
  const c = criteria as Criteria | null | undefined;
  const byId = segments ? new Map(segments.map((s) => [s.segmentId, s])) : undefined;
  return c && criteriaTouchesLiveData(c, byId) ? undefined : Number.POSITIVE_INFINITY;
}

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

export const segmentCountsQuery = (criteria: Criteria, segments: SegmentRows) =>
  queryOptions({
    queryKey: [
      "segment-counts",
      JSON.stringify(criteria),
      segmentRefsVersion(criteria, segments),
    ] as const,
    queryFn: () => client.segments.count({ criteria }),
    staleTime: liveAwareStaleTime(criteria, segments),
  });

export type SegmentPoints = {
  origin: [number, number];
  deltas: Float32Array;
};

// gcTime:0 releases the multi-MB Float32Array the moment the query goes
// inactive — accumulating multiple buffers triggers V8 GC pauses.
export const segmentPointsQuery = (criteria: Criteria, segments: SegmentRows) =>
  queryOptions({
    queryKey: [
      "segment-points",
      JSON.stringify(criteria),
      segmentRefsVersion(criteria, segments),
    ] as const,
    queryFn: () => fetchSegmentPoints({ criteria }),
    staleTime: liveAwareStaleTime(criteria, segments),
    gcTime: 0,
  });

export const segmentSampleQuery = (criteria: Criteria, segments: SegmentRows) =>
  queryOptions({
    queryKey: [
      "segment-sample",
      JSON.stringify(criteria),
      segmentRefsVersion(criteria, segments),
    ] as const,
    queryFn: () => client.segments.sample({ criteria }),
    staleTime: liveAwareStaleTime(criteria, segments),
  });

export const segmentCascadeQuery = (criteria: Criteria, segments: SegmentRows) =>
  queryOptions({
    queryKey: [
      "segment-cascade",
      JSON.stringify(criteria),
      segmentRefsVersion(criteria, segments),
    ] as const,
    queryFn: () => client.segments.countCascade({ criteria }),
    staleTime: liveAwareStaleTime(criteria, segments),
  });

// Binary mercator-delta pairs — uploaded directly into a GPU buffer,
// so the response stays as raw bytes the whole way through (no JSON
// envelope, no per-byte JS decode). Lives outside oRPC for that
// reason; auth / org are enforced by the /api proxy on the web edge.
//
// Wire: 16-byte header (two fp64 — origin x, y in [0,1] mercator),
// then N*8 bytes of fp32 (dx, dy). The fp64 origin is critical: the
// per-frame `cameraMerc - origin` subtract in PointsLayer happens at
// fp64, and an fp32 origin would re-introduce the precision loss the
// delta encoding exists to fix.
export async function fetchSegmentPoints(input: {
  criteria: unknown;
  keyFilter?: { keyGroup: string; keys: string[] } | null;
}): Promise<SegmentPoints> {
  const orgSlug = getCurrentOrgSlug();
  const res = await fetch(`/api/web/${orgSlug}/segment-points`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      criteria: input.criteria,
      keyFilter: input.keyFilter,
    }),
  });
  if (!res.ok) throw new Error(`segment-points failed: ${res.status} ${await res.text()}`);
  const buf = await res.arrayBuffer();
  const header = new Float64Array(buf, 0, 2);
  const deltas = new Float32Array(buf, 16);
  return { origin: [header[0]!, header[1]!], deltas };
}

// Buildings for the turf cutter, narrowed by segment criteria and
// optionally further filtered to a specific zone's keys. Pass
// `zoneId: null` and `keyFilter: undefined` for zoneless campaigns —
// the cutter then renders the full segment's points. `segmentCriteria`
// is `unknown`-typed at the type level, so passing `undefined` is
// structurally allowed for disabled-state calls.
export const cutterBuildingsQuery = (
  zoneId: string | null,
  segmentCriteria: SegmentCriteria,
  keyFilter: { keyGroup: string; keys: string[] } | undefined,
  segments: SegmentRows,
) =>
  queryOptions({
    queryKey: [
      "cutter-buildings",
      zoneId,
      segmentCriteria ? JSON.stringify(segmentCriteria) : null,
      keyFilter ? JSON.stringify(keyFilter) : null,
      segmentRefsVersion(segmentCriteria, segments),
    ] as const,
    queryFn: () =>
      client.segments.listBuildings({
        criteria: segmentCriteria,
        keyFilter,
      }),
    staleTime: liveAwareStaleTime(segmentCriteria, segments),
  });
