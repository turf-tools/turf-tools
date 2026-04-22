import { cn } from "~/lib/utils";
import { Breadcrumb } from "./breadcrumb";
import { UserBadge } from "./user-badge";

// Top chrome: sticky at the top of the Shell's max-width wrapper with a
// bottom border. Breadcrumb on the left (which owns the track picker
// inline via its chevron button), user chrome on the right.
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
      <UserBadge />
    </header>
  );
}
