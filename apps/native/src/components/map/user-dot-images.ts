import type { ImageRequireSource } from "react-native";

// 3x sprites: the layer renders them at 1/3 scale. The beam is baked in
// black or white because MapLibre symbol images are not tinted.
export const USER_DOT_CONE_IMAGES: Record<string, ImageRequireSource> = {
  "cone-55-light": require("../../../assets/map/cone-55-black.png"),
  "cone-75-light": require("../../../assets/map/cone-75-black.png"),
  "cone-100-light": require("../../../assets/map/cone-100-black.png"),
  "cone-55-dark": require("../../../assets/map/cone-55.png"),
  "cone-75-dark": require("../../../assets/map/cone-75.png"),
  "cone-100-dark": require("../../../assets/map/cone-100.png"),
};

const CONE_ANGLE_BY_ACCURACY: Record<number, number> = { 3: 55, 2: 75, 1: 100 };

export function coneImageFor(headingAccuracy: number | null, isDark: boolean): string | undefined {
  if (headingAccuracy == null) return undefined;
  const angle = CONE_ANGLE_BY_ACCURACY[headingAccuracy];
  if (angle == null) return undefined;
  return `cone-${angle}-${isDark ? "dark" : "light"}`;
}
