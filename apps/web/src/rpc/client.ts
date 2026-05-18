import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createRouterClient } from "@orpc/server";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { db } from "@field-tools/db";
import { webRouter, type WebRouter } from ".";
import { buildWebContext } from "./context";

const getClient = createIsomorphicFn()
  .server(() =>
    createRouterClient(webRouter, {
      context: async () => {
        const headers = new Headers(getRequestHeaders());
        return buildWebContext(db, headers);
      },
    }),
  )
  .client(() => {
    const link = new RPCLink({
      url: `${window.location.origin}/api/web/rpc`,
    });
    return createORPCClient(link);
  });

// Dev-only RPC timing. Wraps every client level as a Proxy that traps both
// property access (to keep `client.segments.list` chaining intact, since oRPC
// returns callable proxies at every level) and invocation (to time the call).
// Filter the console by "[rpc]" to see what's running during a user
// interaction and how long each call took.
function timedRpc<T extends object>(target: T, path: string[] = []): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (typeof prop === "symbol" || prop === "then" || value == null) return value;
      if (typeof value === "function" || typeof value === "object") {
        return timedRpc(value as object, [...path, String(prop)]);
      }
      return value;
    },
    apply(t, thisArg, args) {
      const t0 = performance.now();
      const result = Reflect.apply(t as (...a: unknown[]) => unknown, thisArg, args);
      if (result instanceof Promise) {
        return result.finally(() => {
          const ms = performance.now() - t0;
          console.log(`[rpc] ${path.join(".")} ${ms.toFixed(0)}ms`);
        });
      }
      return result;
    },
  }) as T;
}

const rawClient = getClient() as RouterClient<WebRouter>;
export const client = import.meta.env.DEV ? timedRpc(rawClient) : rawClient;
