// Web → data proxy for segment-export downloads. A GET so the browser can
// navigate to it directly (the `Content-Disposition` header triggers the
// download); the criteria is looked up server-side from the segment id. The
// data service's file response streams straight through via `passthrough` —
// no buffering in the web server.

import { createFileRoute } from "@tanstack/react-router";
import { and, db, eq } from "@turf-tools/db";
import { segments } from "@turf-tools/db/schema";
import { dataFetch, passthrough } from "~/lib/server/data-proxy";
import { buildWebContext } from "~/rpc/context";

export const Route = createFileRoute("/api/web/$orgSlug/segment-export")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const orgSlug = url.pathname.match(/^\/api\/web\/([^/]+)\/segment-export$/)?.[1];
        if (!orgSlug) return new Response("Not Found", { status: 404 });

        let context: Awaited<ReturnType<typeof buildWebContext>>;
        try {
          context = await buildWebContext(db, request.headers, orgSlug);
        } catch {
          return new Response("Unauthorized", { status: 401 });
        }

        const segmentId = url.searchParams.get("segmentId");
        const format = url.searchParams.get("format") === "parquet" ? "parquet" : "csv";
        if (!segmentId) return new Response("Bad Request", { status: 400 });

        const [seg] = await db
          .select({ name: segments.name, criteria: segments.criteria })
          .from(segments)
          .where(
            and(
              eq(segments.segmentId, segmentId),
              eq(segments.organizationId, context.organizationId),
            ),
          );
        if (!seg) return new Response("Not Found", { status: 404 });

        const upstream = await dataFetch("/segments/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            criteria: seg.criteria ?? { steps: [] },
            orgSlug: context.orgSlug,
            format,
          }),
        });
        if (!upstream.ok) {
          return new Response(await upstream.text(), { status: upstream.status });
        }

        // Structured audit breadcrumb — no table yet (see docs/product.md).
        console.info(
          JSON.stringify({
            event: "segment.export",
            userId: context.user.id,
            orgId: context.organizationId,
            segmentId,
            format,
            rows: upstream.headers.get("X-Export-Rows"),
          }),
        );

        const date = new Date().toISOString().slice(0, 10);
        const safeName = (seg.name || "segment").replace(/[^\w.-]+/g, "_").slice(0, 80);
        return passthrough(upstream, {
          "Content-Disposition": `attachment; filename="${safeName}-${date}.${format}"`,
        });
      },
    },
  },
});
