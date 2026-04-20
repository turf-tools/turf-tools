import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { Router } from "web/rpc";

const link = new RPCLink({
  url: `${process.env.EXPO_PUBLIC_API_URL}/api/rpc`,
  // Timeout rejects with a non-AbortError so @tanstack/offline-transactions
  // treats it as retriable (it drops AbortError as non-retriable).
  fetch: (url, init) => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10_000);
    return fetch(url, { ...init, signal: controller.signal })
      .catch((err) => {
        if (timedOut) throw new Error("Request timed out");
        throw err;
      })
      .finally(() => clearTimeout(timeout));
  },
});

export const client = createORPCClient(link) as RouterClient<Router>;
