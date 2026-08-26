import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

export const zoneGroupsQuery = () =>
  queryOptions({
    queryKey: ["zone-groups"] as const,
    queryFn: () => client.zoneGroups.list(),
  });

export const zonesQuery = (zoneGroupId: string) =>
  queryOptions({
    queryKey: ["zones", zoneGroupId] as const,
    queryFn: () => client.zones.list({ zoneGroupId }),
  });

// Version stamp for zonePerimetersQuery: the per-zone key assignment
// plus the boundary dataset version — the two inputs that change
// shapes. Shared so prefetches key identically to the page's query.
export function zonePerimetersVersion(
  datasetVersionId: string | undefined,
  zones: ReadonlyArray<{ zoneId: string; keys: string[] }> | undefined,
): string {
  return JSON.stringify([datasetVersionId, zones?.map((z) => [z.zoneId, z.keys])]);
}

// Server-side GEOS zone unions (see apps/data /zones/perimeters).
// `version` is an optional cache-busting stamp: pages that watch zone
// edits fold `zonePerimetersVersion` into it so shape changes re-key
// immediately; pages that don't pass one accept staleTime-bounded
// staleness.
export const zonePerimetersQuery = (zoneGroupIds: string[], version = "") =>
  queryOptions({
    queryKey: ["zone-perimeters", [...zoneGroupIds].sort(), version] as const,
    queryFn: () => client.results.perimeters({ zoneGroupIds }),
    staleTime: 5 * 60_000,
    enabled: zoneGroupIds.length > 0,
  });
