import { createFileRoute } from "@tanstack/react-router";
import { RPCHandler } from "@orpc/server/fetch";
import { db } from "@turf-tools/db";
import { newTimingStore, serverTimingValue, timed, timingScope } from "~/lib/server/timing";
import { webRouter } from "../../rpc";
import { buildWebContext } from "../../rpc/context";

const handler = new RPCHandler(webRouter);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const Route = createFileRoute("/api/web/$orgSlug/rpc/$")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        const url = new URL(request.url);
        const match = url.pathname.match(/^\/api\/web\/([^/]+)\/rpc(\/.*)?$/);
        const orgSlug = match?.[1];
        if (!orgSlug) {
          return new Response("Not Found", { status: 404, headers: corsHeaders });
        }

        const store = newTimingStore();
        const t0 = performance.now();
        const res = await timingScope.run(store, async () => {
          const context = await timed("auth", () => buildWebContext(db, request.headers, orgSlug));
          const { response } = await handler.handle(request, {
            prefix: `/api/web/${orgSlug}/rpc`,
            context,
          });
          return response ?? new Response("Not Found", { status: 404 });
        });

        for (const [key, value] of Object.entries(corsHeaders)) {
          res.headers.set(key, value);
        }
        store.durations.set("total", performance.now() - t0);
        res.headers.set("Server-Timing", serverTimingValue(store));
        return res;
      },
    },
  },
});
