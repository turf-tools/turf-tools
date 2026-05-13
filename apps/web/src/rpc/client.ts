import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createRouterClient } from "@orpc/server";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { db } from "@field-tools/db";
import { adminRouter, type AdminRouter } from ".";
import { buildAdminContext } from "./context";

const getClient = createIsomorphicFn()
  .server(() =>
    createRouterClient(adminRouter, {
      context: async () => {
        const headers = new Headers(getRequestHeaders());
        return buildAdminContext(db, headers);
      },
    }),
  )
  .client(() => {
    const link = new RPCLink({
      url: `${window.location.origin}/api/admin/rpc`,
    });
    return createORPCClient(link);
  });

export const client = getClient() as RouterClient<AdminRouter>;
