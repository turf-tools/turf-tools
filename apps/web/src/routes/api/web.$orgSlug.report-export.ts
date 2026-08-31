// Web → data proxy for report downloads. A GET so the browser can navigate
// to it directly (the `Content-Disposition` header triggers the download);
// the page's transient scope (campaign, day, sort) rides along as search
// params and is forwarded to the data service, which validates it.

import { createFileRoute } from "@tanstack/react-router";
import { db } from "@turf-tools/db";
import { REPORT_KINDS, type ReportKind } from "~/lib/reports";
import { dataFetch, passthrough } from "~/lib/server/data-proxy";
import { buildVoterDataContext } from "~/rpc/context";

export const Route = createFileRoute("/api/web/$orgSlug/report-export")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const orgSlug = url.pathname.match(/^\/api\/web\/([^/]+)\/report-export$/)?.[1];
        if (!orgSlug) return new Response("Not Found", { status: 404 });

        let context: Awaited<ReturnType<typeof buildVoterDataContext>>;
        try {
          context = await buildVoterDataContext(db, request.headers, orgSlug);
        } catch {
          return new Response("Unauthorized", { status: 401 });
        }

        const kind = url.searchParams.get("kind") as ReportKind | null;
        if (!kind || !REPORT_KINDS.includes(kind)) {
          return new Response("Bad Request", { status: 400 });
        }
        const format = url.searchParams.get("format") === "parquet" ? "parquet" : "csv";
        const campaignId = url.searchParams.get("campaign");
        const day = url.searchParams.get("day");
        const tz = url.searchParams.get("tz");
        const sort = url.searchParams.get("sort");
        const dir = url.searchParams.get("dir") === "desc" ? "desc" : "asc";

        const upstream = await dataFetch(`/reports/${kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orgSlug: context.orgSlug,
            format,
            ...(campaignId ? { campaignIds: [campaignId] } : {}),
            ...(day && tz ? { day, tz } : {}),
            ...(sort ? { sort, dir } : {}),
          }),
        });
        if (!upstream.ok) {
          return new Response(await upstream.text(), { status: upstream.status });
        }

        // Structured audit breadcrumb — no table yet (see docs/product.md).
        console.info(
          JSON.stringify({
            event: "report.export",
            userId: context.user.id,
            orgId: context.organizationId,
            kind,
            format,
            rows: upstream.headers.get("X-Export-Rows"),
          }),
        );

        const date = new Date().toISOString().slice(0, 10);
        return passthrough(upstream, {
          "Content-Disposition": `attachment; filename="${kind}-${date}.${format}"`,
        });
      },
    },
  },
});
