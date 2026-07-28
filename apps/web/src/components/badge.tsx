import type { CSSProperties, ReactNode } from "react";
import { cn } from "~/lib/utils";

// Colored chips derive their whole palette from one accent color: a
// translucent background tint and a contrast-shifted foreground. The
// math lives in styles.css (.badge-tint / .badge-fg) behind CSS vars —
// tweak live at /badges. Pair this helper with those classes on any
// element that can't use <Badge> (table pills, turf badges).
export function tintStyle(color: string): CSSProperties {
  return { "--badge-color": color } as CSSProperties;
}

// Small inline tag — script step types, segment verbs.
export function Badge({
  color,
  className,
  children,
}: {
  color: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className={cn("badge-tint rounded px-1.5 py-0.5 text-xs font-medium", className)}
      style={tintStyle(color)}
    >
      {children}
    </span>
  );
}
