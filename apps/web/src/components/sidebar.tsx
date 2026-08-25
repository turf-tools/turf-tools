import { Link } from "@tanstack/react-router";
import {
  ChartNoAxesColumn,
  CheckCheck,
  CircleUser,
  Database,
  LayoutDashboard,
  Layers,
  type LucideIcon,
  Map,
  Megaphone,
  PanelLeftClose,
  PanelLeftOpen,
  ClipboardPen,
  Search,
  Settings,
  TrendingUp,
  Users,
  Waypoints,
  Files,
} from "lucide-react";
import { hasPermission, type Permission } from "~/lib/permissions";
import { cn } from "~/lib/utils";

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  requires?: Permission;
};

// Everything except Turfs requires voter-data access — field leads see
// only the turfs board (plus Settings/Account below).
export const PRIMARY: NavItem[] = [
  { to: "/$orgSlug/overview", label: "Overview", icon: LayoutDashboard, requires: "voter.read" },
  { to: "/$orgSlug/campaigns", label: "Campaigns", icon: Megaphone, requires: "voter.read" },
  { to: "/$orgSlug/segments", label: "Segments", icon: Layers, requires: "voter.read" },
  { to: "/$orgSlug/zones", label: "Zones", icon: Waypoints, requires: "voter.read" },
  { to: "/$orgSlug/turfs", label: "Turfs", icon: Map },
  { to: "/$orgSlug/progress", label: "Progress", icon: TrendingUp, requires: "voter.read" },
  { to: "/$orgSlug/lookup", label: "Lookup", icon: Search, requires: "voter.read" },
  { to: "/$orgSlug/scripts", label: "Scripts", icon: ClipboardPen, requires: "voter.read" },
  { to: "/$orgSlug/questions", label: "Questions", icon: CheckCheck, requires: "voter.read" },
  { to: "/$orgSlug/results", label: "Results", icon: ChartNoAxesColumn, requires: "voter.read" },
  { to: "/$orgSlug/reports", label: "Reports", icon: Files, requires: "voter.read" },
];

export const SECONDARY: NavItem[] = [
  { to: "/$orgSlug/users", label: "Users", icon: Users, requires: "users.manage" },
  { to: "/$orgSlug/data", label: "Data", icon: Database, requires: "datasets.manage" },
  { to: "/$orgSlug/settings", label: "Settings", icon: Settings },
  { to: "/$orgSlug/account", label: "Account", icon: CircleUser },
];

type SidebarProps = {
  collapsed: boolean;
  onToggle: () => void;
  role: string | null;
  orgSlug: string;
};

// Fixed-height rows (h-9) so the icon's vertical position is stable.
// Icons always sit at 16px from the sidebar's left edge (nav pl-2 +
// link pl-2) — aligned with the breadcrumb. The collapsed sidebar is
// w-12 (48px), which is exactly wide enough that 16px-from-left is also
// the visual center, so icons stay put through the width transition
// rather than sliding as the container shrinks around them.
export function Sidebar({ collapsed, onToggle, role, orgSlug }: SidebarProps) {
  const visible = (items: NavItem[]) =>
    items.filter((i) => !i.requires || (role != null && hasPermission(role, i.requires)));

  return (
    <nav className="flex h-full flex-col gap-6 overflow-y-auto px-2 pt-3.5 pb-4">
      <NavGroup
        items={visible(PRIMARY)}
        collapsed={collapsed}
        orgSlug={orgSlug}
        className="border-b border-border pb-2"
      />
      <div className="flex-1" />
      <NavGroup
        items={visible(SECONDARY)}
        collapsed={collapsed}
        orgSlug={orgSlug}
        className="border-y border-border py-2"
      />
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex h-9 items-center gap-3",
          "rounded-md px-2",
          "text-sm text-foreground",
          "hover:bg-muted hover:text-foreground",
        )}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? (
          <PanelLeftOpen className="size-4 shrink-0" />
        ) : (
          <PanelLeftClose className="size-4 shrink-0" />
        )}
        {!collapsed && <span className="whitespace-nowrap">Collapse</span>}
      </button>
    </nav>
  );
}

function NavGroup({
  items,
  collapsed,
  orgSlug,
  className,
}: {
  items: NavItem[];
  collapsed: boolean;
  orgSlug: string;
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-col gap-1", className)}>
      {items.map((item) => (
        <li key={item.to}>
          <NavLink item={item} collapsed={collapsed} orgSlug={orgSlug} />
        </li>
      ))}
    </ul>
  );
}

function NavLink({
  item,
  collapsed,
  orgSlug,
}: {
  item: NavItem;
  collapsed: boolean;
  orgSlug: string;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      params={{ orgSlug }}
      // Skip the focus side-effect of mousedown so click doesn't leave
      // a focus ring after a dialog returns focus here. Tab navigation
      // is unaffected.
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        "flex h-9 items-center gap-3",
        "rounded-md px-2",
        "text-sm text-foreground",
        "hover:bg-muted",
      )}
      activeProps={{ className: "bg-muted" }}
      activeOptions={{ exact: false }}
      title={collapsed ? item.label : undefined}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
    </Link>
  );
}
