import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { Router } from "web/rpc";

const link = new RPCLink({
  url: `${process.env.EXPO_PUBLIC_API_URL}/api/rpc`,
  fetch: (url, init) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
  },
});

export const client = createORPCClient(link) as RouterClient<Router>;
