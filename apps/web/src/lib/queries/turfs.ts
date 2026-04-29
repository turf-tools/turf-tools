import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

export const turfsListQuery = (campaignId: string | null) =>
  queryOptions({
    queryKey: ["turfs", campaignId] as const,
    queryFn: () => client.turfs.listForOrg(campaignId ? { campaignId } : undefined),
  });
