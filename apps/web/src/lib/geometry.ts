// Bounding box over features' coordinates, as [minLng, minLat, maxLng,
// maxLat] for the map's fitBounds; null when there are no coordinates.
export function bboxOfFeatures(
  features: GeoJSON.Feature[],
): [number, number, number, number] | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const visit = (coords: unknown) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      minLng = Math.min(minLng, coords[0] as number);
      maxLng = Math.max(maxLng, coords[0] as number);
      minLat = Math.min(minLat, coords[1] as number);
      maxLat = Math.max(maxLat, coords[1] as number);
      return;
    }
    for (const c of coords) visit(c);
  };
  for (const f of features) {
    if ("coordinates" in f.geometry) visit(f.geometry.coordinates);
  }
  if (!Number.isFinite(minLng)) return null;
  return [minLng, minLat, maxLng, maxLat];
}

// Ray-casting point-in-polygon. Works in any coordinate system —
// callers use either lng/lat or screen coords.
export function pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Open vertex list `[[lng,lat],...]` → GeoJSON Polygon (closing ring).
export function verticesToPolygon(vertices: Array<[number, number]>): {
  type: "Polygon";
  coordinates: number[][][];
} {
  const ring: number[][] = vertices.map((v) => [v[0], v[1]]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push([first[0]!, first[1]!]);
  }
  return { type: "Polygon", coordinates: [ring] };
}

// GeoJSON Polygon → open vertex list (drops the closing duplicate).
export function polygonToVertices(polygon: {
  type: "Polygon";
  coordinates: number[][][];
}): Array<[number, number]> {
  const ring = polygon.coordinates[0] ?? [];
  if (ring.length >= 2) {
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] === last[0] && first[1] === last[1]) {
      return ring.slice(0, -1).map((p) => [p[0]!, p[1]!] as [number, number]);
    }
  }
  return ring.map((p) => [p[0]!, p[1]!] as [number, number]);
}
