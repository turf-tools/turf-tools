import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";
import { fetchSegmentPoints, type SegmentCriteria } from "./segments";

export type KeyFilter = { keyGroup: string; keys: string[] };

export const campaignsListQuery = () =>
  queryOptions({
    queryKey: ["campaigns"] as const,
    queryFn: () => client.campaigns.list(),
  });

export const campaignDetailQuery = (campaignId: string) =>
  queryOptions({
    queryKey: ["campaign", campaignId] as const,
    queryFn: () => client.campaigns.getById({ campaignId }),
  });

// Cache key includes the resolved keys (not just zoneGroupId), so a zones
// edit anywhere busts this naturally via key change.
export const campaignPointsQuery = (
  segmentCriteria: SegmentCriteria,
  keyFilter: KeyFilter | null,
) =>
  queryOptions({
    queryKey: [
      "campaign-points",
      JSON.stringify(segmentCriteria),
      keyFilter ? JSON.stringify(keyFilter) : null,
    ] as const,
    queryFn: () => fetchSegmentPoints({ criteria: segmentCriteria, keyFilter }),
    staleTime: Number.POSITIVE_INFINITY,
    // Release inactive points buffers immediately. Each big campaign is
    // ~5MB of Float32Array backing memory; accumulating multiple in
    // cache triggers V8 GC pauses (200-700ms) on later navigations.
    // Trade-off: revisiting a campaign refetches points (predictable
    // loading curtain) instead of risking an unexplained freeze.
    gcTime: 0,
  });

export const campaignKeyCountsQuery = (
  segmentCriteria: SegmentCriteria,
  keyGroup: string,
  keys: string[],
) =>
  queryOptions({
    queryKey: ["campaign-key-counts", JSON.stringify(segmentCriteria), keyGroup, keys] as const,
    queryFn: () =>
      client.segments.countByKey({
        criteria: segmentCriteria,
        keyGroup,
        keyFilter: { keyGroup, keys },
      }),
    staleTime: Number.POSITIVE_INFINITY,
  });
