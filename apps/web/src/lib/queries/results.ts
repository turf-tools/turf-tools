import { queryOptions } from "@tanstack/react-query";
import type { Filter } from "~/lib/filters";
import { client } from "~/rpc/client";

// Flat conditions: each chip is one leaf AND'd onto the everyone-
// baseline — `narrow`, or `remove` when negated ("Exclude").
export type Condition = { filter: Filter; negated: boolean };

export function conditionsToCriteria(conditions: Condition[]) {
  return {
    steps: conditions.map(({ filter, negated }) => ({
      verb: negated ? "remove" : "narrow",
      filter,
    })),
  };
}

// The newest event sequence in scope — the freshness signal for the
// heavyweight reductions below. Events arrive from native sync, not web
// mutations, so freshness has to be probed, not stamped from a cache.
// Default staleTime: the probe refreshes like any other query (mount,
// refocus) and is the effective freshness bound of the results.
export const resultsEventsVersionQuery = (campaignIds: string[] | null) =>
  queryOptions({
    queryKey: ["results-events-version", campaignIds] as const,
    queryFn: () => client.results.eventsVersion({ campaignIds }),
  });

export const resultsAggregateQuery = (
  campaignIds: string[] | null,
  day: string | null,
  tz: string,
  conditions: Condition[],
  version = "",
) =>
  queryOptions({
    queryKey: [
      "results-aggregate",
      campaignIds,
      day,
      tz,
      JSON.stringify(conditions),
      version,
    ] as const,
    queryFn: () =>
      client.results.aggregate({
        ...(campaignIds && campaignIds.length > 0 ? { campaignIds } : {}),
        ...(day ? { day, tz } : {}),
        ...(conditions.length > 0 ? { criteria: conditionsToCriteria(conditions) } : {}),
      }),
    // Heavyweight event reduction: the events-version stamp re-keys it
    // when events land; staleTime keeps same-version tab-backs silent.
    staleTime: 5 * 60_000,
  });
