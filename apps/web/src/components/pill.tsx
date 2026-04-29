import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

// Pill cells for tabular data. All variants fill their parent width
// (`w-full`) and sit flush against each other vertically, giving the
// "badges stretched across the row" look. Text entries use `bg-card`
// which is pure white in light mode and the elevated-surface color in
// dark mode — offset from the slightly-off-white page background so
// text pills visibly "float".
type Variant = "text" | "number" | "green" | "yellow" | "red" | "blue";

type PillProps = {
  variant?: Variant;
  className?: string;
  children?: ReactNode;
};

export function Pill({ variant = "text", className, children }: PillProps) {
  return (
    <span
      className={cn(
        // Bump SVG stroke-width to 2.5 inside pills only — icons sit
        // alongside small text in the badge, where the default 2 reads
        // a touch too thin against the surrounding font weight. Other
        // icons in the app (header buttons, modal triggers, etc.)
        // stay on the lucide default.
        "flex w-full items-center rounded-md px-2 py-1 text-sm [&_svg]:[stroke-width:2.5]",
        variantClasses(variant),
        className,
      )}
    >
      {children}
    </span>
  );
}

function variantClasses(variant: Variant) {
  switch (variant) {
    // Text and number share the same gray fill; only the font differs.
    // (We tried white for text and it blended into the page background.)
    case "text":
      return "bg-muted";
    case "number":
      return "bg-muted font-mono tabular-nums";
    case "green":
      return "bg-green-light text-green-dark";
    case "yellow":
      return "bg-yellow-light text-yellow-dark";
    case "red":
      return "bg-red-light text-red-dark";
    case "blue":
      return "bg-blue-light text-blue-dark";
  }
}
