// Distinct fill colors for zones in a group. The app palette with the
// trailing neutral gray dropped — gray reads as "unassigned" on a map,
// and we already have an unassigned style for keys without a zone. Nine
// hues remain; beyond that the cycle repeats. Shared between the
// zone editor (per-key fills) and the campaign editor (per-zone
// perimeter fills) so the same zone reads the same color across
// both surfaces.
import { GRAY, PALETTE } from "~/lib/palette";

const ZONE_COLORS = PALETTE.filter((c) => c !== GRAY);

export function colorFor(i: number): string {
  return ZONE_COLORS[i % ZONE_COLORS.length]!;
}
