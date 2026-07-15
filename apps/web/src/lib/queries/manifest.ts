import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";

// The org's active-dataset field manifest. Immutable per active version, so
// `staleTime: Infinity` — a dataset update (active-version flip) invalidates
// this key. Ambient org scoping keys it per org (see queryKeyHashFn).
export const manifestQuery = () =>
  queryOptions({
    queryKey: ["manifest"] as const,
    queryFn: () => client.datasets.manifest(),
    staleTime: Number.POSITIVE_INFINITY,
  });
