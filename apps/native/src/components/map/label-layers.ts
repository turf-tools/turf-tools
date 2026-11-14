import type { LayerSpecification } from "maplibre-gl";

export const LABELS_SOURCE_ID = "labels-omt";

// The basemap already draws road names and building numbers. This overlay
// only pulls house numbers in one zoom level earlier for canvassing.
export function buildLabelLayers({ isDark }: { isDark: boolean }): LayerSpecification[] {
  return [
    {
      id: "labels-housenumber",
      type: "symbol",
      source: LABELS_SOURCE_ID,
      "source-layer": "housenumber",
      minzoom: 17,
      // The basemap's own building numbers start at 18, so hand off there
      // instead of drawing a second set over them.
      maxzoom: 18,
      layout: {
        "text-field": ["get", "housenumber"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 17, 9, 22, 11],
      },
      paint: {
        "text-color": isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 10%)",
        "text-halo-color": isDark ? "hsla(0, 0%, 0%, 0.8)" : "hsla(0, 0%, 100%, 0.97)",
        "text-halo-width": 1,
      },
    },
  ];
}
