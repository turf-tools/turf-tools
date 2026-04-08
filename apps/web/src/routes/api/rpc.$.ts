import { createFileRoute } from "@tanstack/react-router";
import { RPCHandler } from "@orpc/server/fetch";
import { db } from "@field-tools/db";
import { router } from "../../rpc";
import { loadUser } from "../../rpc/context";

const handler = new RPCHandler(router);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const Route = createFileRoute("/api/rpc/$")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        const user = await loadUser(db, request);
        const { response } = await handler.handle(request, {
          prefix: "/api/rpc",
          context: { db, request, user },
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
