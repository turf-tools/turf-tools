// Web → data proxy for the binary points stream. Lives outside the oRPC
// layer because oRPC serializes responses as JSON; pushing a Float32Array
// through that path would force base64 encoding (~25% wire overhead + an
// `atob` + per-byte loop on the browser main thread). Direct binary fetch +
// `arrayBuffer()` skips both — bytes flow network → GPU buffer with no
// JS-side decode.

import { createFileRoute } from "@tanstack/react-router";
import { db } from "@turf-tools/db";
import { dataFetch, passthrough } from "~/lib/server/data-proxy";
import { newTimingStore, serverTimingValue, timed, timingScope } from "~/lib/server/timing";
import { buildVoterDataContext } from "~/rpc/context";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const Route = createFileRoute("/api/web/$orgSlug/segment-points")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const match = url.pathname.match(/^\/api\/web\/([^/]+)\/segment-points$/);
        const orgSlug = match?.[1];
        if (!orgSlug) {
          return new Response("Not Found", { status: 404, headers: corsHeaders });
        }
        const store = newTimingStore();
        const res = await timingScope.run(store, async () => {
          let context;
          try {
            context = await timed("auth", () =>
              buildVoterDataContext(db, request.headers, orgSlug),
            );
          } catch {
            return new Response("Unauthorized", { status: 401 });
          }
          const body = (await request.json()) as {
            criteria: unknown;
            keyFilter?: { keyGroup: string; keys: string[] } | null;
          };
          const upstream = await dataFetch("/buildings/points", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/octet-stream",
            },
            body: JSON.stringify({
              criteria: body.criteria,
              keyFilter: body.keyFilter,
              orgSlug: context.orgSlug,
            }),
          });
          if (!upstream.ok) {
            return new Response(await upstream.text(), { status: upstream.status });
          }
          return passthrough(upstream, corsHeaders);
        });
        for (const [key, value] of Object.entries(corsHeaders)) {
          res.headers.set(key, value);
        }
        res.headers.set("Server-Timing", serverTimingValue(store));
        return res;
      },
    },
  },
});
