import { queryOptions } from "@tanstack/react-query";
import { boardRefreshOptions } from "~/lib/board-refresh";
import { client } from "~/rpc/client";

// Plain options, for the route loader. The board's observers use
// walksLiveQuery.
export const walksListQuery = (campaignId: string | null) =>
  queryOptions({
    queryKey: ["walks", campaignId] as const,
    queryFn: () => client.walks.listForOrg(campaignId ? { campaignId } : undefined),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

// Immediacy comes from the SSE nudge; the poll covers a dropped stream,
// faster while the stream is down. The interval pauses while the tab is
// hidden (refetchIntervalInBackground defaults false).
export const walksLiveQuery = (campaignId: string | null, streamUp: boolean) =>
  queryOptions({
    ...walksListQuery(campaignId),
    ...boardRefreshOptions(
      (signal) => client.walks.listForOrg(campaignId ? { campaignId } : undefined, { signal }),
      streamUp,
    ),
  });
