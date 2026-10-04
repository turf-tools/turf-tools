import { createFileRoute } from "@tanstack/react-router";
import { RPCHandler } from "@orpc/server/fetch";
import { db } from "@turf-tools/db";
import { nativeRouter } from "../../rpc";

const handler = new RPCHandler(nativeRouter);

const LOGGED_PATHS = new Set(["/turfs/getByCode", "/walks/open", "/walks/close"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const Route = createFileRoute("/api/native/rpc/$")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        const startedAt = Date.now();
        const { response } = await handler.handle(request, {
          prefix: "/api/native/rpc",
          context: { db },
        });

        const res = response ?? new Response("Not Found", { status: 404 });
        const path = new URL(request.url).pathname.slice("/api/native/rpc".length);
        if (LOGGED_PATHS.has(path) || res.status !== 200) {
          const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "-";
          console.log(
            `[native] ${request.method} ${path} status=${res.status} ms=${Date.now() - startedAt} ip=${ip}`,
          );
        }
        for (const [key, value] of Object.entries(corsHeaders)) {
          res.headers.set(key, value);
        }
        return res;
      },
    },
  },
});
