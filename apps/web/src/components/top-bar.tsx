import { cn } from "~/lib/utils";
import { Breadcrumb } from "./breadcrumb";
import { LightDarkToggle } from "./light-dark-toggle";
import { LoadingIndicator } from "./loading-indicator";
import { UserBadge } from "./user-badge";

// Top chrome: sticky at the top of the Shell's max-width wrapper with a
// bottom border. Breadcrumb on the left, user-side chrome on the right.
export function TopBar() {
  return (
    <header
      className={cn(
        "sticky top-0 z-40",
        "flex h-14 items-center justify-between",
        "border-b border-border bg-background",
        "px-4",
      )}
    >
      <Breadcrumb />
      <div className="flex items-center gap-3 text-sm">
        <LoadingIndicator />
        <LightDarkToggle />
        <UserBadge />
      </div>
    </header>
  );
}
