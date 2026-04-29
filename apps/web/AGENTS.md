# Comment style

Keep comments minimal but use them where helpful — like when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, or behavior that would surprise a reader. Keep them short, usually one line. Don't recap rejected alternatives or earlier approaches.

# Admin page pattern

Canonical examples: `src/routes/turfs/index.tsx` (simple), `src/routes/segments/index.tsx` (with in-component dim UX), `src/routes/campaigns/index.tsx` (multi-tier loader with dependent queries).

## Data

- `queryOptions(...)` helpers live in `src/lib/queries/<domain>.ts`, one file per entity. Every query helper goes there, even single-use ones — keeps a route's data dependencies legible at the import line.
- **Cache keys must encode everything that determines the result.** If a query depends on a derived input (e.g. `keyFilter` resolved from zones), put it in the cache key. Cross-page propagation then happens automatically: an upstream change → derived input changes → cache key changes → fresh fetch. No `invalidateQueries` needed for that path.
- Default `staleTime: 15_000` lives on the QueryClient (`src/router.tsx`). Per-query overrides only when deliberate (`Number.POSITIVE_INFINITY` for fully key-determined data like boundary GeoJSON or points).
- After mutations, prefer optimistic cache writes (`setQueryData` in `onMutate`) over `invalidateQueries` — writes propagate through shared cache slots to all readers across pages. Use `invalidateQueries` only when the change can't be derived (e.g. list adds/removes/renames that only the list cache knows about).

## Route

- Search schema: TS type + hand-rolled `validateSearch`. Use zod once a route has 3+ params or non-trivial validation.
- `loaderDeps` declares which slice of `search` the loader watches.
- `loader` uses `Promise.all([...])` for parallel fetches; tier them when later fetches depend on earlier ones (see campaigns: lists → detail → bound entities → heavy data).
- `loader` uses `fetchQuery` (respects staleness), not `ensureQueryData` (always returns cache).
- Page state (active entity id, filters) lives in the URL — no atoms. Loader redirects to a deterministic fallback (typically alphabetical-first) when the URL id is missing or invalid. This also handles post-delete naturally.

## Component

- Read URL state via `Route.useSearch()`; write via `useNavigate({ from: Route.fullPath })`.
- Suspense boundary scoped to data-dependent content; chrome (h1, dropdown, toolbar) outside.
- `useSuspenseQuery` for queries the loader prefetched as essentials. `useQuery` for conditional queries (with `enabled`) and for queries that drive in-component dim/curtain UX during binding swaps (with `placeholderData: keepPreviousData` + `isPlaceholderData`).
- Wrap the route's outer element with `animate-in fade-in duration-100` gated by `useFadeOnce(routePath)` — fades on first session boot, instant on subsequent navs.

## UI components

- Generic UI components stay stateless and prop-driven; the route owns data fetching and derives the props.
- For derived labels that depend on async-fetched data, render whitespace when still resolving — never a misleading default that could flash before styles apply.

## Loading indicator

- Subscribes to `useIsFetching` (with `meta.silent` filter), `useIsMutating`, and router state (`isLoading || matches.some(m => m.status === "pending")`). Always-mounted, opacity-toggled.
- A query opts into `meta: { silent: true }` only when something else is already showing the user "loading" (a curtain, an inline spinner, a coordinator query).

## Mutations

- Optimistic cache writes via `onMutate` + rollback. The cache is the single source of truth — readers across pages see the new state without explicit invalidation.
- For high-frequency mutations (rapid polygon clicks, debounced auto-saves), use `scope: { id: ... }` so they serialize on the server and last-write-wins is reliable.
- Use `useDialogMutation` for dialog-bound mutations — bundles the open flag with the mutation lifecycle.
