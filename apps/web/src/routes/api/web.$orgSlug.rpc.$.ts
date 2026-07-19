import { createFileRoute } from "@tanstack/react-router";
import { RPCHandler } from "@orpc/server/fetch";
import { db } from "@turf-tools/db";
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

        const context = await buildWebContext(db, request.headers, orgSlug);
        const { response } = await handler.handle(request, {
          prefix: `/api/web/${orgSlug}/rpc`,
          context,
        });

        const res = response ?? new Response("Not Found", { status: 404 });
        for (const [key, value] of Object.entries(corsHeaders)) {
          res.headers.set(key, value);
        }
        return res;
      },
    },
  },
});
