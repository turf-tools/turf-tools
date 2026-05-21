import { queryOptions } from "@tanstack/react-query";
import type { FeatureCollection } from "geojson";
import { getCurrentOrgSlug } from "~/lib/current-route";

// Static immutable per (keyGroup, updatedAt) — stale only when the data
// pipeline rebuilds, which bumps updatedAt and changes the cache key. The
// current orgSlug is folded into the hash by the QueryClient's
// `queryKeyHashFn`, so two orgs with the same keyGroup don't collide.
export const boundariesGeoJsonQuery = (keyGroup: string, updatedAt: Date | string) =>
  queryOptions({
    queryKey: ["boundaries-geojson", keyGroup, updatedAt] as const,
    queryFn: async (): Promise<FeatureCollection> => {
      const orgSlug = getCurrentOrgSlug();
      const url = `/api/web/${orgSlug}/boundaries/${keyGroup}/geojson?v=${new Date(updatedAt).getTime()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`boundaries fetch failed: ${res.status}`);
      return (await res.json()) as FeatureCollection;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
