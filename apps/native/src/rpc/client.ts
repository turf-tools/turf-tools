import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { NativeRouter } from "web/rpc";

type Client = RouterClient<NativeRouter>;

// Survives HMR — module-level `let` gets reset when the module reloads, which
// orphans the active client and breaks every RPC call until full reload.
type RpcGlobal = { host: string | null; client: Client | null };
const g = globalThis as { __fieldToolsRpc?: RpcGlobal };
g.__fieldToolsRpc ??= { host: null, client: null };
const state: RpcGlobal = g.__fieldToolsRpc;

// localhost and common LAN ranges run on http; everything else is https.
function buildBaseUrl(host: string): string {
  const protocol = /^localhost(:|$)|^127\.|^192\.168\.|^10\./.test(host) ? "http" : "https";
  return `${protocol}://${host}/api/native/rpc`;
}

function buildClient(host: string): Client {
  const link = new RPCLink({
    url: buildBaseUrl(host),
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
  return createORPCClient(link) as Client;
}

export function setHost(host: string) {
  state.host = host;
  state.client = buildClient(host);
}

export function clearHost() {
  state.host = null;
  state.client = null;
}

export function getHost(): string | null {
  return state.host;
}

// Proxy that forwards top-level access to the active client. Procedures are
// always invoked inline (`client.turfs.getByCode(...)`) so each call passes
// through this trap — switching hosts mid-flight is safe.
export const client = new Proxy({} as Client, {
  get(_, prop) {
    if (!state.client) {
      throw new Error("RPC client not initialized — call setHost() first.");
    }
    return state.client[prop as keyof Client];
  },
});
