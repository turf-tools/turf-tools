import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createRouterClient } from "@orpc/server";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { db } from "@field-tools/db";
import { router, type Router } from ".";
import { loadUser } from "./context";

const getClient = createIsomorphicFn()
  .server(() =>
    createRouterClient(router, {
      context: async () => {
        const request = new Request("http://localhost", {
          headers: getRequestHeaders(),
        });
        return {
          db,
          request,
          user: await loadUser(db, request),
        };
      },
    }),
  )
  .client(() => {
    const link = new RPCLink({
      url: `${window.location.origin}/api/rpc`,
    });
    return createORPCClient(link);
  });

export const client = getClient() as RouterClient<Router>;
