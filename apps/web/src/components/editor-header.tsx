import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

// One row on desktop; on phones the title stands alone and each control
// takes its own row, so long filter labels can't squeeze the heading.
export function EditorHeader({
  title,
  subtitle,
  leading,
  children,
}: {
  title: string;
  subtitle?: string | null;
  leading?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mb-5 flex flex-col gap-3",
        "md:mb-4 md:h-8 md:flex-row md:items-center md:justify-between",
      )}
    >
      <div className="flex items-center gap-3">
        {leading}
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-extrabold tracking-wide italic">{title}</h1>
          {subtitle ? (
            <span className="hidden text-sm text-muted-foreground italic md:inline">
              {subtitle}
            </span>
          ) : null}
        </div>
      </div>
      {children ? (
        <div className="flex flex-col items-start gap-3 md:flex-row md:items-center md:gap-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}
