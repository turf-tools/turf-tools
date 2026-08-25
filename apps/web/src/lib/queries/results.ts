import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

export const resultsAggregateQuery = (
  campaignIds: string[] | null,
  day: string | null,
  tz: string,
) =>
  queryOptions({
    queryKey: ["results-aggregate", campaignIds, day, tz] as const,
    queryFn: () =>
      client.results.aggregate({
        ...(campaignIds && campaignIds.length > 0 ? { campaignIds } : {}),
        ...(day ? { day, tz } : {}),
      }),
    staleTime: 30_000,
  });

// Perimeters change only when zones are edited or the boundary version
// flips; a modest staleTime keeps map interactions snappy without a
// bespoke invalidation chain.
export const zonePerimetersQuery = (zoneGroupIds: string[]) =>
  queryOptions({
    queryKey: ["zone-perimeters", [...zoneGroupIds].sort()] as const,
    queryFn: () => client.results.perimeters({ zoneGroupIds }),
    staleTime: 5 * 60_000,
    enabled: zoneGroupIds.length > 0,
  });
