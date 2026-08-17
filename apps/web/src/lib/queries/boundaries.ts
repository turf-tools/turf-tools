import { queryOptions } from "@tanstack/react-query";
import type { FeatureCollection } from "geojson";
import { getCurrentOrgSlug } from "~/lib/current-route";

// Static immutable per (keyGroup, active dataset version) — the data service
// serves boundaries from the org's active version's schema, so `version` is
// the manifest's `versionId`. Version-keyed URLs let every view of a keyGroup
// (and the browser's HTTP cache — upstream sends `immutable`) share one copy.
// The current orgSlug is folded into the hash by the QueryClient's
// `queryKeyHashFn`, so two orgs with the same keyGroup don't collide.
export const boundariesGeoJsonQuery = (keyGroup: string, version: string) =>
  queryOptions({
    queryKey: ["boundaries-geojson", keyGroup, version] as const,
    queryFn: async (): Promise<FeatureCollection> => {
      const orgSlug = getCurrentOrgSlug();
      const url = `/api/web/${orgSlug}/boundaries/${keyGroup}/geojson?v=${version}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`boundaries fetch failed: ${res.status}`);
      return (await res.json()) as FeatureCollection;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
