import type { LayerSpecification } from "maplibre-gl";

export const USER_DOT_SOURCE_ID = "user-location-dot";

// A 19pt outer dot with a 3pt ring. MapLibre strokes sit outside the
// circle radius, so the fill radius is 6.5pt and the stroke takes it to
// 9.5pt.
const DOT_RADIUS = 6.5;
const DOT_STROKE_WIDTH = 3;
const DOT_OUTER_RADIUS = DOT_RADIUS + DOT_STROKE_WIDTH;
const HALO_SCALE = 2.25;
const HALO_OPACITY = 0.35;

// The sprites are 372px (3x of the 124pt cone box).
const CONE_ICON_SIZE = 1 / 3;

export type UserDotFeatureProps = {
  heading?: number;
  coneImage?: string;
};

export function buildUserDotData({
  position,
  heading,
  coneImage,
}: {
  position: [number, number] | null;
  heading: number | null;
  coneImage: string | undefined;
}): GeoJSON.FeatureCollection<GeoJSON.Point, UserDotFeatureProps> {
  if (!position) {
    return { type: "FeatureCollection", features: [] };
  }

  const properties: UserDotFeatureProps = {};
  if (heading != null && coneImage) {
    properties.heading = heading;
    properties.coneImage = coneImage;
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: position },
        properties,
      },
    ],
  };
}

export function buildUserDotLayers({
  isDark,
  haloProgress,
}: {
  isDark: boolean;
  haloProgress: number;
}): LayerSpecification[] {
  const dotColor = isDark ? "#ffffff" : "#000000";
  const ringColor = isDark ? "#000000" : "#ffffff";
  const haloRadius = DOT_OUTER_RADIUS * (1 + (HALO_SCALE - 1) * haloProgress);
  const haloOpacity = HALO_OPACITY * (1 - haloProgress);

  return [
    {
      id: "user-location-cone",
      type: "symbol",
      source: USER_DOT_SOURCE_ID,
      filter: ["all", ["has", "heading"], ["has", "coneImage"]],
      layout: {
        "icon-image": ["get", "coneImage"],
        "icon-size": CONE_ICON_SIZE,
        "icon-rotate": ["get", "heading"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-anchor": "center",
      },
    },
    {
      id: "user-location-halo",
      type: "circle",
      source: USER_DOT_SOURCE_ID,
      paint: {
        "circle-radius": haloRadius,
        "circle-color": dotColor,
        "circle-opacity": haloOpacity,
      },
    },
    {
      id: "user-location-dot",
      type: "circle",
      source: USER_DOT_SOURCE_ID,
      paint: {
        "circle-radius": DOT_RADIUS,
        "circle-color": dotColor,
        "circle-stroke-color": ringColor,
        "circle-stroke-width": DOT_STROKE_WIDTH,
      },
    },
  ];
}
