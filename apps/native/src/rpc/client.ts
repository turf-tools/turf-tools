import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { Router } from "web/rpc";

const link = new RPCLink({
  url: `${process.env.EXPO_PUBLIC_API_URL}/api/rpc`,
});

export const client = createORPCClient(link) as RouterClient<Router>;
