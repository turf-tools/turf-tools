import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

// Immediacy comes from the SSE nudge (see useLiveRefresh), not this
// interval — the poll is the safety net for a dropped stream, and
// refetchOnWindowFocus covers picking the phone back up. The interval
// pauses when the tab is hidden (refetchIntervalInBackground defaults
// false), so a phone in a pocket costs nothing.
export const walksListQuery = (campaignId: string | null) =>
  queryOptions({
    queryKey: ["walks", campaignId] as const,
    queryFn: () => client.walks.listForOrg(campaignId ? { campaignId } : undefined),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
