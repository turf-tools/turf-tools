import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function EditorPage({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col overflow-hidden px-4 pt-4 pb-5 md:pl-5",
        className,
      )}
    >
      {children}
    </div>
  );
}
