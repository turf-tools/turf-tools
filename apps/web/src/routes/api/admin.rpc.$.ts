import { createFileRoute } from "@tanstack/react-router";
import { RPCHandler } from "@orpc/server/fetch";
import { db } from "@field-tools/db";
import { adminRouter } from "../../rpc";
import { buildAdminContext } from "../../rpc/context";

const handler = new RPCHandler(adminRouter);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const Route = createFileRoute("/api/admin/rpc/$")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        const context = await buildAdminContext(db, request.headers);
        const { response } = await handler.handle(request, {
          prefix: "/api/admin/rpc",
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
