import { Link } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import type { SessionOrg } from "~/lib/server/session";
import { hasPermission } from "~/lib/permissions";
import { cn } from "~/lib/utils";
import { Breadcrumb } from "./breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { LightDarkToggle } from "./light-dark-toggle";
import { LoadingIndicator } from "./loading-indicator";
import { PRIMARY, SECONDARY, type NavItem } from "./sidebar";
import { UserBadge } from "./user-badge";

// Top chrome: sticky at the top of the Shell's max-width wrapper with a
// bottom border. Breadcrumb on the left, user-side chrome on the right.
// On mobile the sidebar is hidden, so a circled menu button (rightmost)
// carries the navigation instead.
type TopBarProps = {
  orgSlug: string;
  orgName: string;
  orgs: ReadonlyArray<SessionOrg>;
  role: string | null;
};

export function TopBar({ orgSlug, orgName, orgs, role }: TopBarProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-40",
        "flex h-14 items-center justify-between",
        "border-b border-border bg-background",
        "px-4",
      )}
    >
      <Breadcrumb orgSlug={orgSlug} orgName={orgName} orgs={orgs} />
      <div className="flex items-center gap-3 text-sm">
        <LoadingIndicator />
        <LightDarkToggle />
        <UserBadge />
        <MobileMenu role={role} orgSlug={orgSlug} />
      </div>
    </header>
  );
}

function MobileMenu({ role, orgSlug }: { role: string | null; orgSlug: string }) {
  const visible = (items: NavItem[]) =>
    items.filter((i) => !i.requires || (role != null && hasPermission(role, i.requires)));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Menu"
        className={cn(
          "flex size-8 items-center justify-center md:hidden",
          "rounded-full border border-border",
          "hover:bg-muted aria-expanded:bg-muted",
        )}
      >
        <Menu className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {[...visible(PRIMARY), ...visible(SECONDARY)].map((item) => (
          <DropdownMenuItem
            key={item.to}
            // No hover on touch, so intent-preload gets ~0 head start and the
            // old page lingers while the target loader runs. Render-preload
            // warms every section the moment the menu opens instead.
            render={<Link to={item.to} params={{ orgSlug }} preload="render" />}
            className="gap-3"
          >
            <item.icon className="size-4" />
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
