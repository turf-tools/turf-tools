// Bridges TanStack Router's live state to non-React call sites (RPC client,
// `fetch`-based query factories). Reading orgSlug from `useParams` requires
// React context; this lets us read it from anywhere on the browser. The
// reference is installed by `router.tsx` on first construction.

type RouterLike = {
  state: {
    matches: ReadonlyArray<{
      routeId: string;
      params: Record<string, string | undefined>;
    }>;
  };
};

let liveRouter: RouterLike | null = null;

export function __registerRouter(router: RouterLike): void {
  liveRouter = router;
}

export function getCurrentOrgSlug(): string | null {
  if (!liveRouter) return null;
  const match = liveRouter.state.matches.find((m) => m.routeId === "/$orgSlug");
  return match?.params.orgSlug ?? null;
}

// First path segment of a URL pathname, or null if the path is `/`. Used
// SSR-side (where the router isn't constructed yet) to derive the slug
// from the incoming request URL.
export function slugFromPathname(pathname: string): string | null {
  const first = pathname.split("/").filter(Boolean)[0];
  return first ?? null;
}
