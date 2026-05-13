import { queryOptions } from "@tanstack/react-query";
import type { FeatureCollection } from "geojson";

// Static immutable per (keyGroup, updatedAt) — stale only when the data
// pipeline rebuilds, which bumps updatedAt and changes the cache key.
export const boundariesGeoJsonQuery = (keyGroup: string, updatedAt: Date | string) =>
  queryOptions({
    queryKey: ["boundaries-geojson", keyGroup, updatedAt] as const,
    queryFn: async (): Promise<FeatureCollection> => {
      const url = `/api/web/boundaries/${keyGroup}/geojson?v=${new Date(updatedAt).getTime()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`boundaries fetch failed: ${res.status}`);
      return (await res.json()) as FeatureCollection;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
