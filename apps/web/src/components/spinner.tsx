import { Icon } from "~/components/icon";
import { cn } from "~/lib/utils";

// Subtle spinning indicator. Uses Tailwind's `animate-spin` which matches
// the turf-app reference (1s linear infinite).
type SpinnerProps = {
  className?: string;
  size?: number;
};

export function Spinner({ className, size = 24 }: SpinnerProps) {
  return (
    <Icon
      name="loader-circle"
      className={cn("animate-spin text-muted-foreground", className)}
      width={size}
      height={size}
    />
  );
}
