import { and, eq, inArray, sql } from "@turf-tools/db";
import { campaigns, canvassEvents, turfs } from "@turf-tools/db/schema";
import { z } from "zod";
import { dataPostJson } from "~/lib/server/data-proxy";
import { webPub as pub } from "../context";

// Cheap freshness probe for the event-log reductions: the newest event
// sequence in scope. Events arrive from outside the web client (native
// sync), so report pages fold this into their cache keys — the
// heavyweight aggregate refetches only when events actually changed.
export const eventsVersion = pub
  .input(z.object({ campaignIds: z.array(z.string().uuid()).nullish() }))
  .handler(async ({ context, input }): Promise<{ version: string }> => {
    const rows = await context.db
      .select({ latest: sql<string | null>`max(${canvassEvents.sequence})::text` })
      .from(canvassEvents)
      .innerJoin(turfs, eq(canvassEvents.turfId, turfs.turfId))
      .innerJoin(campaigns, eq(turfs.campaignId, campaigns.campaignId))
      .where(
        and(
          eq(campaigns.organizationId, context.organizationId),
          ...(input.campaignIds?.length ? [inArray(campaigns.campaignId, input.campaignIds)] : []),
        ),
      );
    return { version: rows[0]?.latest ?? "0" };
  });

export type ZoneFunnelRow = {
  zoneId: string | null;
  zoneName: string | null;
  // Set only on null-zone rows: the full-segment campaign's segment.
  // Zoneless rows split per segment server-side.
  segmentId: string | null;
  segmentName: string | null;
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
