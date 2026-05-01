import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";
import type { SegmentCriteria } from "./segments";

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
    queryFn: async (): Promise<Float32Array> => {
      const res = await fetch("/api/segment-points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ criteria: segmentCriteria, keyFilter }),
      });
      if (!res.ok) throw new Error(`segment-points failed: ${res.status} ${await res.text()}`);
      return new Float32Array(await res.arrayBuffer());
    },
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
      client.segments.countByKey({
        criteria: segmentCriteria,
        keyGroup,
        keyFilter: { keyGroup, keys },
      }),
    staleTime: Number.POSITIVE_INFINITY,
  });
