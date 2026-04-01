import { createFileRoute } from "@tanstack/react-router";
import { RPCHandler } from "@orpc/server/fetch";
import { router } from "../../rpc";

const handler = new RPCHandler(router);

export const Route = createFileRoute("/api/rpc/$")({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        const { response } = await handler.handle(request, {
          prefix: "/api/rpc",
          context: {},
        });
        return response ?? new Response("Not Found", { status: 404 });
      },
    },
  },
});
