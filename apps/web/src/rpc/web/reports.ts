import { z } from "zod";
import { REPORT_KINDS, type ReportRows } from "~/lib/reports";
import { dataPostJson } from "~/lib/server/data-proxy";
import { webPub as pub } from "../context";

// Row-level canvass report preview; the reduction, voter-file columns,
// and question pivots live in apps/data /reports/<kind>. Downloads go
// through /api/web/$orgSlug/report-export instead. The wire types live
// in ~/lib/reports (client-safe).
export const rows = pub
  .input(
    z.object({
      kind: z.enum(REPORT_KINDS),
      campaignIds: z.array(z.string().uuid()).optional(),
      day: z.string().optional(),
      tz: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      sort: z.string().optional(),
      dir: z.enum(["asc", "desc"]).optional(),
    }),
  )
  .handler(async ({ context, input }): Promise<ReportRows> => {
    return dataPostJson<ReportRows>(`/reports/${input.kind}`, {
      orgSlug: context.orgSlug,
      campaignIds: input.campaignIds,
      day: input.day,
      tz: input.tz,
      offset: input.offset,
      sort: input.sort,
      dir: input.dir,
      format: "preview",
    });
  });
