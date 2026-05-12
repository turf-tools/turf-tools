// Web → data proxy for the boundaries GeoJSON. The data service is internal
// — we never want the browser to know its URL — so even shape data that the
// map library loads goes through the web edge. Streamed (not buffered) so a
// multi-MB response doesn't sit in Node memory. Cache-Control passes through
// unchanged so the `?v=updatedAt` cache-busting strategy keeps working.

import { createFileRoute } from "@tanstack/react-router";
import { db } from "@field-tools/db";
import { dataFetch, passthrough } from "~/lib/server/data-proxy";
import { buildAdminContext } from "~/rpc/context";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const Route = createFileRoute("/api/admin/boundaries/$keyGroup/geojson")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders }),
      GET: async ({ request }) => {
        try {
          await buildAdminContext(db, request.headers);
        } catch {
          return new Response("Unauthorized", { status: 401, headers: corsHeaders });
        }
        const url = new URL(request.url);
        const match = url.pathname.match(/^\/api\/admin\/boundaries\/([^/]+)\/geojson$/);
        const keyGroup = match?.[1];
        if (!keyGroup) {
          return new Response("Not Found", { status: 404, headers: corsHeaders });
        }
        const upstreamPath = `/key-groups/${encodeURIComponent(keyGroup)}/geojson${url.search}`;
        const upstream = await dataFetch(upstreamPath);
        if (!upstream.ok) {
          return new Response(await upstream.text(), {
            status: upstream.status,
            headers: corsHeaders,
          });
        }
        return passthrough(upstream, corsHeaders);
      },
    },
  },
});
