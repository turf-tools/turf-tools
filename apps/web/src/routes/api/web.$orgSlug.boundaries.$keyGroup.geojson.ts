// Web → data proxy for the boundaries GeoJSON. The data service is internal
// — we never want the browser to know its URL — so even shape data that the
// map library loads goes through the web edge. Streamed (not buffered) so a
// multi-MB response doesn't sit in Node memory. Cache-Control passes through
// unchanged so the `?v=updatedAt` cache-busting strategy keeps working.

import { createFileRoute } from "@tanstack/react-router";
import { db } from "@turf-tools/db";
import { dataFetch, passthrough } from "~/lib/server/data-proxy";
import { buildWebContext } from "~/rpc/context";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const Route = createFileRoute("/api/web/$orgSlug/boundaries/$keyGroup/geojson")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const match = url.pathname.match(/^\/api\/web\/([^/]+)\/boundaries\/([^/]+)\/geojson$/);
        const orgSlug = match?.[1];
        const keyGroup = match?.[2];
        if (!orgSlug || !keyGroup) {
          return new Response("Not Found", { status: 404, headers: corsHeaders });
        }
        let context;
        try {
          context = await buildWebContext(db, request.headers, orgSlug);
        } catch {
          return new Response("Unauthorized", { status: 401, headers: corsHeaders });
        }
        // Forward existing query (e.g. `?v=<updatedAt>` cache-buster) and
        // tack on the org slug from the auth context. Snake-case to match
        // the path param (`/key-groups/{key_group}/`) — URL convention.
        const upstreamQuery = new URLSearchParams(url.search);
        upstreamQuery.set("org_slug", context.orgSlug);
        const upstreamPath = `/key-groups/${encodeURIComponent(keyGroup)}/geojson?${upstreamQuery.toString()}`;
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
