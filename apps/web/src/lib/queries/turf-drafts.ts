import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

export const turfDraftsQuery = (campaignId: string, zoneId: string) =>
  queryOptions({
    queryKey: ["turfDrafts", campaignId, zoneId] as const,
    queryFn: () => client.turfDrafts.list({ campaignId, zoneId }),
  });
