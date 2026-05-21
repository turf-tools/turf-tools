// Semantic colors for canvasser-result states. Self-contained — all hex
// values are hand-specified per role × theme so they can be tuned
// independently.
//
// Shades:
//   background — fill color used for badge backgrounds and map dots.
//   foreground — deep text/icon color paired with `background`.

import { useAtomValue } from "jotai";
import { themeAtom } from "@/lib/atoms/theme";

type Role = "contacted" | "unavailable";
type Variant = { background: string; foreground: string };
type Themed = { light: Variant; dark: Variant };

export const colors: Record<Role, Themed> = {
  contacted: {
    light: {
      background: "#f5d0fe", // fuscia 200
      foreground: "#86198f", // fuscia 800
    },
    dark: {
      background: "#5D0F61", // fuschia 925
      foreground: "#F2BEFD", // fuscia 250
    },
  },
  unavailable: {
    light: {
      background: "#fed7aa", // orange 200
      foreground: "#9a3412", // orange 800
    },
    dark: {
      background: "#5F2009", // orange 925
      foreground: "#FED4A4", // orange 250
    },
  },
};

// Hook returning theme-resolved variants for every role. Use this in
// components so callers don't have to thread `isDark` through themselves.
//
//   const colors = useColors();
//   <Icon color={colors.contacted.foreground} />
//   <View style={{ backgroundColor: colors.unavailable.background }} />
export function useColors(): Record<Role, Variant> {
  const isDark = useAtomValue(themeAtom) === "dark";
  const theme = isDark ? "dark" : "light";
  return {
    contacted: colors.contacted[theme],
    unavailable: colors.unavailable[theme],
  };
}
