import { z } from "zod";
import { dataPostJson } from "~/lib/server/data-proxy";
import { webPub as pub } from "../context";

export type ZoneFunnelRow = {
  zoneId: string | null;
  zoneName: string | null;
  attempted: number;
  contacted: number;
  // questionId → optionId → count, among the contacted.
  responses: Record<string, Record<string, number>>;
  // questionId → count of contacted who answered at all (non-empty
  // options or text) — the completion stat for open-ended questions.
  answered: Record<string, number>;
};

export type ResultsAggregate = {
  // Distinct canvass days (display-timezone dates, newest first) in the
  // campaign scope, ignoring the day filter — the date chip's options.
  days: string[];
  rows: ZoneFunnelRow[];
};

// Per-zone canvass funnel; the reduction and semantics live in
// apps/data /results/aggregate.
export const aggregate = pub
  .input(
    z.object({
      campaignIds: z.array(z.string().uuid()).optional(),
      criteria: z.unknown().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      day: z.string().optional(),
      tz: z.string().optional(),
    }),
  )
  .handler(async ({ context, input }): Promise<ResultsAggregate> => {
    return dataPostJson<ResultsAggregate>("/results/aggregate", {
      orgSlug: context.orgSlug,
      campaignIds: input.campaignIds,
      criteria: input.criteria,
      start: input.start,
      end: input.end,
      day: input.day,
      tz: input.tz,
    });
  });

export type ZonePerimeters = GeoJSON.FeatureCollection;

// Server-side GEOS zone unions (see apps/data /zones/perimeters).
export const perimeters = pub
  .input(z.object({ zoneGroupIds: z.array(z.string().uuid()).min(1) }))
  .handler(async ({ context, input }): Promise<ZonePerimeters> => {
    return dataPostJson<ZonePerimeters>("/zones/perimeters", {
      orgSlug: context.orgSlug,
      zoneGroupIds: input.zoneGroupIds,
    });
  });
