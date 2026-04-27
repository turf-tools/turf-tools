// Distinct fill colors for zones in a group. Tailwind's 500 scale
// across the rainbow, shuffled so adjacent zones land on far-apart
// hues — up to 17 zones render distinctly; beyond that the cycle
// repeats. Shared between the zone editor (per-key fills) and the
// campaign editor (per-zone perimeter fills) so the same zone reads
// the same color across both surfaces.

const ZONE_COLORS = [
  "#3b82f6", // blue-500
  "#f97316", // orange-500
  "#22c55e", // green-500
  "#d946ef", // fuchsia-500
  "#eab308", // yellow-500
  "#06b6d4", // cyan-500
  "#ec4899", // pink-500
  "#84cc16", // lime-500
  "#8b5cf6", // violet-500
  "#10b981", // emerald-500
  "#f43f5e", // rose-500
  "#0ea5e9", // sky-500
  "#f59e0b", // amber-500
  "#a855f7", // purple-500
  "#14b8a6", // teal-500
  "#ef4444", // red-500
  "#6366f1", // indigo-500
];

export function colorFor(i: number): string {
  return ZONE_COLORS[i % ZONE_COLORS.length]!;
}
