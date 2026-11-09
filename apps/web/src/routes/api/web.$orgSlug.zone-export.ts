// Web → data proxy for zone group downloads: a two-column key → zone file,
// the same shape zone import reads. A GET so the browser can navigate to it
// directly; the zones are read and org-scoped here and handed to the data
// service, which writes the CSV or Parquet file.

import { createFileRoute } from "@tanstack/react-router";
import { and, asc, db, eq } from "@turf-tools/db";
import { zoneGroups, zones } from "@turf-tools/db/schema";
import { dataFetch, passthrough } from "~/lib/server/data-proxy";
import { buildPermittedContext } from "~/rpc/context";

export const Route = createFileRoute("/api/web/$orgSlug/zone-export")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const orgSlug = url.pathname.match(/^\/api\/web\/([^/]+)\/zone-export$/)?.[1];
        if (!orgSlug) return new Response("Not Found", { status: 404 });

        let context: Awaited<ReturnType<typeof buildPermittedContext>>;
        try {
          context = await buildPermittedContext(db, request.headers, orgSlug, "zones.read");
        } catch {
          return new Response("Unauthorized", { status: 401 });
        }

        const zoneGroupId = url.searchParams.get("zoneGroupId");
        const format = url.searchParams.get("format") === "parquet" ? "parquet" : "csv";
        if (!zoneGroupId) return new Response("Bad Request", { status: 400 });

        const [group] = await db
          .select({ name: zoneGroups.name })
          .from(zoneGroups)
          .where(
            and(
              eq(zoneGroups.zoneGroupId, zoneGroupId),
              eq(zoneGroups.organizationId, context.organizationId),
            ),
          );
        if (!group) return new Response("Not Found", { status: 404 });

        const rows = await db
          .select({ name: zones.name, keys: zones.keys })
          .from(zones)
          .where(eq(zones.zoneGroupId, zoneGroupId))
          .orderBy(asc(zones.order), asc(zones.createdAt));

        const upstream = await dataFetch("/zones/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ zones: rows, format }),
        });
        if (!upstream.ok) {
          return new Response(await upstream.text(), { status: upstream.status });
        }

        const date = new Date().toISOString().slice(0, 10);
        const safeName = (group.name || "zones").replace(/[^\w.-]+/g, "_").slice(0, 80);
        return passthrough(upstream, {
          "Content-Disposition": `attachment; filename="${safeName}-${date}.${format}"`,
        });
      },
    },
  },
});
