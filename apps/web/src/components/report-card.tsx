import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

// Card chrome shared by summary panels (the Results funnel and question
// cards, the Reports summary rail): rows inside an inset margin so the
// thin dividers stop at the padding. Pass a flex className (and a
// trailing flex-1 filler child) to stretch the card — the divider then
// closes off the last row and the space below stays empty.
export function ReportCard({
  className,
  divided = true,
  children,
}: {
  className?: string;
  // Rows that carry their own visual separation (e.g. bars) skip the
  // hairlines.
  divided?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("rounded-md border border-border bg-card", className)}>
      <div
        className={cn(
          "mx-3 flex min-h-0 flex-1 flex-col overflow-y-auto",
          divided && "divide-y divide-border/60",
        )}
      >
        {children}
      </div>
    </div>
  );
}
