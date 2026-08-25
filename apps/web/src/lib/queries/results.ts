import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { Filter } from "~/lib/filters";
import { client } from "~/rpc/client";

// Flat conditions: each chip is one leaf AND'd onto the everyone-
// baseline — `narrow`, or `remove` when negated ("is not").
export type Condition = { filter: Filter; negated: boolean };

export function conditionsToCriteria(conditions: Condition[]) {
  return {
    steps: conditions.map(({ filter, negated }) => ({
      verb: negated ? "remove" : "narrow",
      filter,
    })),
  };
}

export const resultsAggregateQuery = (
  campaignIds: string[] | null,
  day: string | null,
  tz: string,
  conditions: Condition[],
) =>
  queryOptions({
    queryKey: ["results-aggregate", campaignIds, day, tz, JSON.stringify(conditions)] as const,
    queryFn: () =>
      client.results.aggregate({
        ...(campaignIds && campaignIds.length > 0 ? { campaignIds } : {}),
        ...(day ? { day, tz } : {}),
        ...(conditions.length > 0 ? { criteria: conditionsToCriteria(conditions) } : {}),
      }),
    staleTime: 30_000,
    // Filter/scope changes swap data in place — no suspension, no flash.
    placeholderData: keepPreviousData,
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
