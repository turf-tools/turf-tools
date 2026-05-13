import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { NativeRouter } from "web/rpc";

type Client = RouterClient<NativeRouter>;

let activeHost: string | null = null;
let activeClient: Client | null = null;

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
  activeHost = host;
  activeClient = buildClient(host);
}

export function clearHost() {
  activeHost = null;
  activeClient = null;
}

export function getHost(): string | null {
  return activeHost;
}

// Proxy that forwards top-level access to the active client. Procedures are
// always invoked inline (`client.turfs.getByCode(...)`) so each call passes
// through this trap — switching hosts mid-flight is safe.
export const client = new Proxy({} as Client, {
  get(_, prop) {
    if (!activeClient) {
      throw new Error("RPC client not initialized — call setHost() first.");
    }
    return activeClient[prop as keyof Client];
  },
});
