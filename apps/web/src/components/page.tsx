import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function Page({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={cn("p-4 md:pl-5", className)}>{children}</div>;
}
