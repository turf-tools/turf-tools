import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createRouterClient } from "@orpc/server";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";
import { db } from "@field-tools/db";
import { getCurrentOrgSlug, slugFromPathname } from "~/lib/current-route";
import { webRouter, type WebRouter } from ".";
import { buildWebContext } from "./context";

const getClient = createIsomorphicFn()
  .server(() =>
    createRouterClient(webRouter, {
      context: async () => {
        const headers = new Headers(getRequestHeaders());
        // SSR: the slug lives in the incoming page URL's first segment.
        const orgSlug = slugFromPathname(getRequestUrl().pathname);
        if (!orgSlug) {
          throw new Error("SSR RPC call outside an org-scoped route");
        }
        return buildWebContext(db, headers, orgSlug);
      },
    }),
  )
  .client(() => {
    // Browser: URL is reconstructed per call from the live router state,
    // so navigating between orgs routes subsequent calls to the right
    // `/api/web/<slug>/rpc/*` prefix without rebuilding the link.
    const link = new RPCLink({
      url: () => {
        const orgSlug = getCurrentOrgSlug();
        if (!orgSlug) {
          throw new Error("RPC call outside an org-scoped route");
        }
        return `${window.location.origin}/api/web/${orgSlug}/rpc`;
      },
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
