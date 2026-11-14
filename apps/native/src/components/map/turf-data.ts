import type { TurfDataBuilding } from "@turf-tools/db/schema";

export type BuildingProps = {
  buildingId: string;
  doorCount: number;
  // 0 = no result, 1 = unavailable (any recorded), 2 = contacted (any
  // response). Numeric so cluster aggregation can take the max: response
  // dominates unavailable, which dominates none.
  role: 0 | 1 | 2;
};

const ROLE_BY_RESULT = { contacted: 2, unavailable: 1 } as const;

// Shared by the native map and the web map: the building features are the same
// GeoJSON either way, only the renderer differs.
export function buildFeatureCollection(
  buildings: TurfDataBuilding[],
  buildingRoles: Map<string, "contacted" | "unavailable">,
): GeoJSON.FeatureCollection<GeoJSON.Point, BuildingProps> {
  const located = buildings.filter(
    (b): b is TurfDataBuilding & { latitude: number; longitude: number } =>
      b.latitude != null && b.longitude != null,
  );

  return {
    type: "FeatureCollection",
    features: located.map((b) => {
      const result = buildingRoles.get(b.buildingId);
      return {
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [b.longitude, b.latitude],
        },
        properties: {
          buildingId: b.buildingId,
          doorCount: b.doors.length,
          role: result ? ROLE_BY_RESULT[result] : 0,
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
