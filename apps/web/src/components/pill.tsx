import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

// Pill cells for tabular data. All variants fill their parent width
// (`w-full`) and sit flush against each other vertically, giving the
// "badges stretched across the row" look.
type Variant = "text" | "number";

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
        "flex h-8 w-full items-center rounded-md border border-transparent bg-clip-padding px-2 text-sm [&_svg]:[stroke-width:2.5]",
        variant === "number" ? "bg-muted font-mono tabular-nums" : "bg-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}
