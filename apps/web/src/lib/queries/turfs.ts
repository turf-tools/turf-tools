import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

export const turfsListQuery = (campaignId: string | null) =>
  queryOptions({
    queryKey: ["turfs", campaignId] as const,
    queryFn: () => client.turfs.listForOrg(campaignId ? { campaignId } : undefined),
  });

export const turfMapDataQuery = (turfId: string) =>
  queryOptions({
    queryKey: ["turf-map-data", turfId] as const,
    queryFn: () => client.turfs.turfMapData({ turfId }),
  });

export const zoneMapDataQuery = (campaignId: string, zoneId: string | null) =>
  queryOptions({
    queryKey: ["zone-map-data", campaignId, zoneId] as const,
    queryFn: () => client.turfs.zoneMapData({ campaignId, zoneId }),
  });

export const turfStatsForCampaignQuery = (campaignId: string) =>
  queryOptions({
    queryKey: ["turf-stats", campaignId] as const,
    queryFn: () => client.turfs.statsForCampaign({ campaignId }),
  });
