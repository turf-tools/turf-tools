import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function EditorPage({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-1 flex-col overflow-hidden p-4 md:pl-5", className)}>
      {children}
    </div>
  );
}
