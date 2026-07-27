import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

// Per-turf attempted counts. Slow cadence: progress moves at
// door-knocking speed and events only reach the server on the
// canvassers' ~30s sync anyway, so polling faster than the data arrives
// buys nothing. The server's TTL cache absorbs many-leads stampedes.
export const progressQuery = (campaignId: string | null) =>
  queryOptions({
    queryKey: ["progress", campaignId] as const,
    queryFn: () => client.progress.forOrg(campaignId ? { campaignId } : undefined),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
