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
      background: "#b2d5ff",
      foreground: "#254476",
    },
    dark: {
      background: "#133160",
      foreground: "#94b8f2",
    },
  },
  unavailable: {
    light: {
      background: "#d6bcac",
      foreground: "#51311d",
    },
    dark: {
      background: "#422d24",
      foreground: "#ddb8a2",
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
