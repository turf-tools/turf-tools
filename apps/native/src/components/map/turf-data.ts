import type { TurfDataBuilding } from "@turf-tools/db/schema";

export type BuildingProps = {
  buildingId: string;
  doorCount: number;
  personCount: number;
  // 0 = no result, 1 = unavailable (any recorded), 2 = contacted (any
  // response). Numeric so cluster aggregation can take the max: response
  // dominates unavailable, which dominates none.
  role: 0 | 1 | 2;
};

// Shared by the native map and the web map: the building features are the same
// GeoJSON either way, only the renderer differs.
export function buildFeatureCollection(
  buildings: TurfDataBuilding[],
  buildingRoles: Map<string, "contacted" | "unavailable">,
): GeoJSON.FeatureCollection<GeoJSON.Point, BuildingProps> {
  return {
    type: "FeatureCollection",
    features: buildings
      .filter((b) => b.latitude != null && b.longitude != null)
      .map((b) => {
        const r = buildingRoles.get(b.buildingId);
        const role: 0 | 1 | 2 = r === "contacted" ? 2 : r === "unavailable" ? 1 : 0;
        return {
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: [b.longitude as number, b.latitude as number],
          },
          properties: {
            buildingId: b.buildingId,
            doorCount: b.doors.length,
            personCount: b.doors.reduce((sum, d) => sum + d.persons.length, 0),
            role,
          },
        };
      }),
  };
}

export function boundsForBuildings(buildings: TurfDataBuilding[]): {
  ne: [number, number];
  sw: [number, number];
} {
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  for (const b of buildings) {
    if (b.latitude == null || b.longitude == null) continue;
    if (b.latitude < minLat) minLat = b.latitude;
    if (b.latitude > maxLat) maxLat = b.latitude;
    if (b.longitude < minLng) minLng = b.longitude;
    if (b.longitude > maxLng) maxLng = b.longitude;
  }
  if (!Number.isFinite(minLat)) {
    return { ne: [-73.96, 40.78], sw: [-73.98, 40.76] };
  }
  return { ne: [maxLng, maxLat], sw: [minLng, minLat] };
}
