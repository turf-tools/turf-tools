import { cn } from "~/lib/utils";

// "Who am I" avatar stub. Just the initials circle for now — real user info
// (name, org, sign-out) lands when auth does.
export function UserBadge() {
  return (
    <div
      className={cn(
        "flex size-8 items-center justify-center",
        "rounded-full bg-foreground",
        "text-xs font-medium text-background",
      )}
    >
      AU
    </div>
  );
}
