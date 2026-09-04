import { queryOptions } from "@tanstack/react-query";
import { client } from "~/rpc/client";
import type { ZonePerimeters } from "~/rpc/web/results";

export const zoneGroupsQuery = () =>
  queryOptions({
    queryKey: ["zone-groups"] as const,
    queryFn: () => client.zoneGroups.list(),
  });

export const zonesQuery = (zoneGroupId: string) =>
  queryOptions({
    queryKey: ["zones", zoneGroupId] as const,
    queryFn: () => client.zones.list({ zoneGroupId }),
  });

// Version stamp for zonePerimetersQuery: the per-zone key assignment
// plus the boundary dataset version — the two inputs that change
// shapes. Shared so prefetches key identically to the page's query.
export function zonePerimetersVersion(
  datasetVersionId: string | undefined,
  zones: ReadonlyArray<{ zoneId: string; keys: string[] }> | undefined,
): string {
  return JSON.stringify([datasetVersionId, zones?.map((z) => [z.zoneId, z.keys])]);
}

// Coarse stamp for pages that don't hold zones lists (Progress/Results):
// the scoped groups' updatedAt — bumped by every zone write — plus the
// boundary dataset version. The campaign editor keeps the finer
// keys-based `zonePerimetersVersion` above.
export function zoneGroupsPerimetersVersion(
  datasetVersionId: string | undefined,
  zoneGroupIds: string[],
  groups: ReadonlyArray<{ zoneGroupId: string; updatedAt: string | Date }> | undefined,
): string {
  const byId = groups ? new Map(groups.map((g) => [g.zoneGroupId, g])) : undefined;
  return JSON.stringify([
    datasetVersionId,
    [...zoneGroupIds].sort().map((id) => [id, byId?.get(id)?.updatedAt ?? null]),
  ]);
}

// Server-side GEOS zone unions (see apps/data /zones/perimeters).
// `version` folds one of the stamps above so zone edits and dataset
// flips re-key. An empty group list resolves locally — the RPC rejects
// it, and there are no shapes to fetch.
export const zonePerimetersQuery = (zoneGroupIds: string[], version = "") =>
  queryOptions({
    queryKey: ["zone-perimeters", [...zoneGroupIds].sort(), version] as const,
    queryFn: (): Promise<ZonePerimeters> =>
      zoneGroupIds.length > 0
        ? client.results.perimeters({ zoneGroupIds })
        : Promise.resolve({ type: "FeatureCollection", features: [] }),
    staleTime: 5 * 60_000,
  });
