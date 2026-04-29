import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

// Per-request QueryClient so SSR doesn't bleed cache between users.
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
    // Previous route stays visible until the loader
    // resolves; pending UI only shows past 300ms.
    defaultPendingMs: 300,
    defaultPendingMinMs: 300,
    defaultPreload: "intent",
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
