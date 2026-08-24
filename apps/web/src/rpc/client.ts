import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createRouterClient } from "@orpc/server";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";
import { db } from "@turf-tools/db";
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

// Per-call RPC timing. Wraps every client level as a Proxy that traps both
// property access (to keep `client.segments.list` chaining intact, since oRPC
// returns callable proxies at every level) and invocation (to time the call),
// reporting each call's duration to `sink`.
type RpcSink = (path: string, ms: number) => void;

function timedRpc<T extends object>(target: T, sink: RpcSink, path: string[] = []): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (typeof prop === "symbol" || prop === "then" || value == null) return value;
      if (typeof value === "function" || typeof value === "object") {
        return timedRpc(value as object, sink, [...path, String(prop)]);
      }
      return value;
    },
    apply(t, thisArg, args) {
      const t0 = performance.now();
      const result = Reflect.apply(t as (...a: unknown[]) => unknown, thisArg, args);
      if (result instanceof Promise) {
        return result.finally(() => sink(path.join("."), performance.now() - t0));
      }
      return result;
    },
  }) as T;
}

// Server: durations land in the request's Server-Timing scope. Lazy
// import keeps node:async_hooks out of the browser bundle.
const serverSink: RpcSink = (path, ms) => {
  void import("~/lib/server/timing").then((m) =>
    m.recordTiming(`rpc-${path.replaceAll(".", "-")}`, ms),
  );
};

const rawClient = getClient() as RouterClient<WebRouter>;
export const client =
  typeof window === "undefined"
    ? timedRpc(rawClient, serverSink)
    : import.meta.env.DEV
      ? // Filter the console by "[rpc]" to see what runs during an
        // interaction and how long each call took.
        timedRpc(rawClient, (path, ms) => console.log(`[rpc] ${path} ${ms.toFixed(0)}ms`))
      : rawClient;
