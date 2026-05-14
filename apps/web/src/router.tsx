import { QueryClient } from "@tanstack/react-query";
import { createRouter, defaultStringifySearch } from "@tanstack/react-router";
import { routerWithQueryClient } from "@tanstack/react-router-with-query";
import { routeTree } from "./routeTree.gen";

// Strip null/undefined search params before serializing so e.g. setting a
// filter back to "All" drops the key from the URL entirely (instead of
// rendering as `?role=null`).
function stringifySearch(search: Record<string, unknown>): string {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(search)) {
    if (v !== null && v !== undefined) cleaned[k] = v;
  }
  return defaultStringifySearch(cleaned);
}

// Per-request QueryClient — no cross-user cache bleed in SSR.
// `routerWithQueryClient` dehydrates loader-prefetched query state on the
// server and rehydrates it on the client so useSuspenseQuery finds it.
export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      // 15s default — long enough that "tab away and back" hits cache,
      // short enough that "data is roughly current." Per-query overrides
      // (`staleTime: Infinity` for key-determined data, `0` for always-
      // fresh) live next to those queries.
      queries: { staleTime: 15_000 },
    },
  });

  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    context: { queryClient },
    stringifySearch,
    // Previous route stays visible until the loader
    // resolves; pending UI only shows past 300ms.
    defaultPendingMs: 300,
    defaultPendingMinMs: 300,
    defaultPreload: "intent",
  });

  return routerWithQueryClient(router, queryClient);
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
