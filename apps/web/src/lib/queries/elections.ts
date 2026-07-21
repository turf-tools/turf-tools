import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

// Distinct elections in the org's active dataset — the option set for the
// voting-history-detail filter's picker. Immutable per active version, so
// `staleTime: Infinity`; a sibling of `manifestQuery` (the active-version flip
// removes both keys — see `data.tsx` `makeActive`). Ambient org scoping keys it
// per org (see `queryKeyHashFn`).
export const electionsQuery = () =>
  queryOptions({
    queryKey: ["elections"] as const,
    queryFn: () => client.datasets.elections(),
    staleTime: Number.POSITIVE_INFINITY,
    // Observers only exist while a detail-filter card is open; without this the
    // loader-prefetched entry gets GC'd after 5 idle minutes and the next mount
    // flashes an empty picker.
    gcTime: Number.POSITIVE_INFINITY,
  });
