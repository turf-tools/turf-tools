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

// Per-(campaign, zone) rollup for the Progress page; same cadence
// rationale as above.
export const progressByZoneQuery = () =>
  queryOptions({
    queryKey: ["progress-by-zone"] as const,
    queryFn: () => client.progress.byZone(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

// Live targets change only with segment edits / dataset flips; slower
// cadence than the event-driven counts. `version` folds the campaign's
// segment updatedAt stamp (see campaignSegmentsVersion) — the criteria
// are read server-side, so without it a segment edit couldn't re-key
// this and tabbing back would serve the stale counts.
export const progressTargetsQuery = (campaignId: string, version: string) =>
  queryOptions({
    queryKey: ["progress-targets", campaignId, version] as const,
    queryFn: () => client.progress.targets({ campaignId }),
    staleTime: 5 * 60_000,
  });
