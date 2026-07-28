import { cn } from "~/lib/utils";

// Solid color key swatch (zone/turf legends). The border is a translucent
// overlay in both themes, so the edge reads as a slightly darker (light
// mode) / lighter (dark mode) shade of the fill rather than a gray ring.
export function Swatch({ color, className }: { color?: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-3 shrink-0 rounded-sm border border-black/15 dark:border-white/18",
        className,
      )}
      style={{ backgroundColor: color }}
    />
  );
}
