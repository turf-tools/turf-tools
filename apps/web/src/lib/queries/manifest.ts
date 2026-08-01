import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

// The org's active-dataset field manifest. Immutable per active version, so a
// non-null result caches forever — a dataset update (active-version flip)
// invalidates this key. A null result ("no active dataset") is always stale:
// the data server auto-activates an org's first ready import, and a hard-cached
// null would keep the no-dataset gate up after that lands. Ambient org scoping
// keys it per org (see queryKeyHashFn).
export const manifestQuery = () =>
  queryOptions({
    queryKey: ["manifest"] as const,
    queryFn: () => client.datasets.manifest(),
    staleTime: (query) => (query.state.data == null ? 0 : Number.POSITIVE_INFINITY),
  });
