import { queryOptions } from "@tanstack/react-query";
import type { ReportKind } from "~/lib/reports";
import { client } from "~/rpc/client";

export type ReportSort = { key: string; dir: "asc" | "desc" } | null;

export const REPORT_PAGE_ROWS = 100;

export const reportRowsQuery = (
  kind: ReportKind,
  campaignIds: string[] | null,
  day: string | null,
  tz: string,
  sort: ReportSort,
  offset: number,
) =>
  queryOptions({
    queryKey: [
      "report-rows",
      kind,
      campaignIds,
      day,
      tz,
      sort?.key ?? null,
      sort?.dir ?? null,
      offset,
    ] as const,
    queryFn: () =>
      client.reports.rows({
        kind,
        offset,
        ...(campaignIds && campaignIds.length > 0 ? { campaignIds } : {}),
        ...(day ? { day, tz } : {}),
        ...(sort ? { sort: sort.key, dir: sort.dir } : {}),
      }),
    // Report data moves only when canvass events sync in; a 5-minute
    // freshness bound keeps tab-backs from re-running the heavyweight
    // query (progressTargetsQuery's convention).
    staleTime: 5 * 60_000,
    // Same-kind scope/sort/page changes swap data in place (the panel
    // dims via isPlaceholderData while the swap is in flight); a kind
    // switch is a different table entirely, so it gets a clean load
    // instead of another kind's rows — lookup's scoped-bridging pattern.
    placeholderData: (previousData, previousQuery) => {
      if (previousData === undefined || previousQuery === undefined) return undefined;
      return previousQuery.queryKey[1] === kind ? previousData : undefined;
    },
  });
