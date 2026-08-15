import { hashKey, MutationCache, QueryClient } from "@tanstack/react-query";
import { createRouter, defaultStringifySearch } from "@tanstack/react-router";
import { toast } from "sonner";
import { routerWithQueryClient } from "@tanstack/react-router-with-query";
import { __registerRouter } from "./lib/current-route";
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

type RouterLike = {
  state: {
    matches: ReadonlyArray<{
      routeId: string;
      params: Record<string, string | undefined>;
    }>;
  };
};

// Per-request QueryClient — no cross-user cache bleed in SSR.
// `routerWithQueryClient` dehydrates loader-prefetched query state on the
// server and rehydrates it on the client so useSuspenseQuery finds it.
export function getRouter() {
  // Captured via a setter to avoid the queryClient↔router type-inference
  // cycle (router context references queryClient; hashFn references router).
  let routerRef: RouterLike | null = null;

  const queryClient: QueryClient = new QueryClient({
    // Default error surface: a mutation without its own onError (and not
    // flagged `meta.errorHandled`, e.g. dialogs showing inline errors) gets a
    // toast — a failed write must never be silent.
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.options.onError || mutation.meta?.errorHandled) return;
        toast.error(error.message);
      },
    }),
    defaultOptions: {
      // 15s default — long enough that "tab away and back" hits cache,
      // short enough that "data is roughly current." Per-query overrides
      // (`staleTime: Infinity` for key-determined data, `0` for always-
      // fresh) live next to those queries.
      queries: {
        staleTime: 15_000,
        // Ambient org scoping: prepend the current $orgSlug to every key
        // before hashing. Two orgs with the same logical key (e.g.
        // `["campaigns"]`) get different cache slots. `routerRef` is
        // captured per-request on SSR, so concurrent requests don't race.
        queryKeyHashFn: (key) => {
          const match = routerRef?.state.matches.find((m) => m.routeId === "/$orgSlug");
          const slug = match?.params.orgSlug;
          return hashKey(slug ? [slug, ...(key as unknown[])] : (key as unknown[]));
        },
      },
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
    // No hover preload: our list queries are staleTime-0 so a preload never
    // saves the navigation fetch, and a preloaded index match commits before
    // its redirect — flashing the empty state.
  });

  routerRef = router;

  // Expose live router state to non-React call sites (RPC client, fetch-
  // based query factories) on the browser. SSR derives the slug from the
  // request URL directly.
  if (typeof window !== "undefined") __registerRouter(router);

  return routerWithQueryClient(router, queryClient);
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
