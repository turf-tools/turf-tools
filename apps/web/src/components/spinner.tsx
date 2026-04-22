import { LoaderCircle } from "lucide-react";
import { cn } from "~/lib/utils";

// Subtle spinning indicator. Uses Tailwind's `animate-spin` which matches
// the turf-app reference (1s linear infinite).
type SpinnerProps = {
  className?: string;
  size?: number;
};

export function Spinner({ className, size = 24 }: SpinnerProps) {
  return (
    <LoaderCircle className={cn("animate-spin text-muted-foreground", className)} size={size} />
  );
}
