// Distinct fill colors for zones in a group. Observable's 10-color
// categorical (`schemeObservable10`) with the trailing neutral
// gray dropped — gray reads as "unassigned" on a map, and we
// already have an unassigned style for keys without a zone. Nine
// hues remain; beyond that the cycle repeats. Shared between the
// zone editor (per-key fills) and the campaign editor (per-zone
// perimeter fills) so the same zone reads the same color across
// both surfaces.
import { interpolateYlOrRd, schemeObservable10 } from "d3-scale-chromatic";

const ZONE_COLORS = schemeObservable10.slice(0, 9);

export function colorFor(i: number): string {
  return ZONE_COLORS[i % ZONE_COLORS.length]!;
}

// Sequential ramp for the segment-counts overlay. Classic
// ColorBrewer YlOrRd via d3-scale-chromatic — perceptually-uniform
// warm ramp that reads unambiguously as "low → high" without
// having to share hue family with the categorical above. Inverted
// in dark mode (dark red low → pale yellow high) so high values
// stay the most visible end of the ramp on a dark basemap.
export function interpolateRamp(t: number, isDark = false): string {
  return interpolateYlOrRd(isDark ? 1 - t : t);
}
