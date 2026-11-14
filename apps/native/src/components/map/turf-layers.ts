import type {
  ExpressionSpecification,
  GeoJSONSourceSpecification,
  LayerSpecification,
} from "maplibre-gl";

export const TURF_SOURCE_ID = "turf-buildings";
export const TURF_PINS_LAYER_ID = "turf-building-pins";
export const TURF_LABELS_LAYER_ID = "turf-building-labels";
export const TURF_CLUSTERS_LAYER_ID = "turf-building-clusters";
export const TURF_CLUSTER_LABELS_LAYER_ID = "turf-building-clusters-label";

export const CLUSTER_RADIUS = 20;
export const CLUSTER_MAX_ZOOM = 18;
export const TILE_MAX_ZOOM = 19;

export const TURF_CLUSTER_PROPERTIES: NonNullable<GeoJSONSourceSpecification["clusterProperties"]> =
  {
    doorCount: [
      ["+", ["accumulated"], ["get", "doorCount"]],
      ["get", "doorCount"],
    ],
    role: [
      ["max", ["accumulated"], ["get", "role"]],
      ["get", "role"],
    ],
    minRole: [
      ["min", ["accumulated"], ["get", "role"]],
      ["get", "role"],
    ],
  };

type RoleColors = Record<"contacted" | "unavailable", { background: string }>;

export function buildTurfLayers({
  isDark,
  colors,
}: {
  isDark: boolean;
  colors: RoleColors;
}): LayerSpecification[] {
  const clusterColor: ExpressionSpecification = [
    "case",
    ["==", ["get", "minRole"], 0],
    isDark ? "#0a0a0a" : "hsl(0, 0%, 88%)",
    ["==", ["get", "role"], 2],
    colors.contacted.background,
    ["==", ["get", "role"], 1],
    colors.unavailable.background,
    isDark ? "#0a0a0a" : "hsl(0, 0%, 88%)",
  ];

  return [
    {
      id: `${TURF_CLUSTERS_LAYER_ID}-shadow`,
      type: "circle",
      source: TURF_SOURCE_ID,
      filter: ["has", "point_count"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 32, 10, 36, 50, 42],
        "circle-color": "hsl(0, 0%, 0%)",
        "circle-opacity": 0.35,
        "circle-blur": 1,
      },
    },
    {
      id: `${TURF_PINS_LAYER_ID}-shadow`,
      type: "circle",
      source: TURF_SOURCE_ID,
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 19, 18, 27],
        "circle-color": "hsl(0, 0%, 0%)",
        "circle-opacity": 0.35,
        "circle-blur": 1,
      },
    },
    {
      id: TURF_CLUSTERS_LAYER_ID,
      type: "circle",
      source: TURF_SOURCE_ID,
      filter: ["has", "point_count"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 20, 10, 24, 50, 30],
        "circle-color": clusterColor,
        "circle-stroke-color": isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 20%)",
        "circle-stroke-width": isDark ? 1 : 1.5,
      },
    },
    {
      id: TURF_CLUSTER_LABELS_LAYER_ID,
      type: "symbol",
      source: TURF_SOURCE_ID,
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "doorCount"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 12, 18, 16],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: { "text-color": isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 10%)" },
    },
    {
      id: TURF_PINS_LAYER_ID,
      type: "circle",
      source: TURF_SOURCE_ID,
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 16],
        "circle-color": [
          "case",
          ["==", ["get", "role"], 2],
          colors.contacted.background,
          ["==", ["get", "role"], 1],
          colors.unavailable.background,
          isDark ? "#1b1b1b" : "hsl(0, 0%, 100%)",
        ] as ExpressionSpecification,
        "circle-stroke-color": isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 20%)",
        "circle-stroke-width": isDark ? 1 : 1.5,
      },
    },
    {
      id: TURF_LABELS_LAYER_ID,
      type: "symbol",
      source: TURF_SOURCE_ID,
      filter: ["!", ["has", "point_count"]],
      layout: {
        "text-field": ["get", "doorCount"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 14],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: { "text-color": isDark ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 10%)" },
    },
  ];
}
