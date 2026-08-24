import type { CSSProperties, ReactNode } from "react";
import { tintStyle } from "~/components/badge";
import { cn } from "~/lib/utils";

// Pill cells for tabular data. All variants fill their parent width
// (`w-full`) and sit flush against each other vertically, giving the
// "badges stretched across the row" look.
type Variant = "text" | "number";

type PillProps = {
  variant?: Variant;
  // Accent color — swaps the muted bg/fg for the shared badge tint
  // (see components/badge.tsx).
  color?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
};

export function Pill({ variant = "text", color, className, style, children }: PillProps) {
  return (
    <span
      // Base lives in styles.css as `.pill` (hoisted for SSR document
      // size). It bumps SVG stroke-width to 2.5 inside pills only —
      // icons sit alongside small text, where the default 2 reads too
      // thin; other icons in the app stay on the lucide default.
      className={cn(
        "pill",
        variant === "number" && "font-mono tabular-nums",
        color ? "badge-tint" : "bg-muted",
        className,
      )}
      style={color ? { ...tintStyle(color), ...style } : style}
    >
      {children}
    </span>
  );
}
