import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";
import { fetchBuildingsPoints, fetchPersonsCountByKey, type SegmentCriteria } from "./segments";

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
    queryFn: () => fetchBuildingsPoints({ criteria: segmentCriteria, keyFilter }),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const campaignKeyCountsQuery = (
  segmentCriteria: SegmentCriteria,
  keyGroup: string,
  keys: string[],
) =>
  queryOptions({
    queryKey: ["campaign-key-counts", JSON.stringify(segmentCriteria), keyGroup, keys] as const,
    queryFn: () =>
      fetchPersonsCountByKey({
        criteria: segmentCriteria,
        keyGroup,
        keyFilter: { keyGroup, keys },
      }),
    staleTime: Number.POSITIVE_INFINITY,
  });
