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
    // Releases the multi-MB Float32Array buffer the moment the query
    // goes inactive — accumulating multiple in cache triggers V8 GC
    // pauses on subsequent navigations.
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
