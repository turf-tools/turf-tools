import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function Page({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={cn("px-3 pt-4 pb-5 md:px-5", className)}>{children}</div>;
}
