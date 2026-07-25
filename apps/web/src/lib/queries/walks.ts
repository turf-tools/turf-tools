import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

// Polled while the turfs page is visible — this is how a lead watches
// sign-outs appear. Tight (5s) because sign-out state drives live
// decisions at the launch table; the payload is a few KB and the query
// is a single indexed join, so the cost is negligible. refetchInterval
// pauses when the tab is hidden (refetchIntervalInBackground defaults
// false), so a phone in a pocket costs nothing.
export const walksListQuery = (campaignId: string | null) =>
  queryOptions({
    queryKey: ["walks", campaignId] as const,
    queryFn: () => client.walks.listForOrg(campaignId ? { campaignId } : undefined),
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });
