import { Link } from "@tanstack/react-router";
import {
  CircleUser,
  Layers,
  type LucideIcon,
  Map,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Split,
  Users,
} from "lucide-react";
import { cn } from "~/lib/utils";

type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
};

const PRIMARY: NavItem[] = [
  { to: "/tracks", label: "Tracks", icon: Split },
  { to: "/lists", label: "Lists", icon: Layers },
  { to: "/turfs", label: "Turfs", icon: Map },
];

const SECONDARY: NavItem[] = [
  { to: "/users", label: "Users", icon: Users },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/account", label: "Account", icon: CircleUser },
];

type SidebarProps = {
  collapsed: boolean;
  onToggle: () => void;
};

// Fixed-height rows (h-9) so the icon's vertical position is stable.
// Icons always sit at 16px from the sidebar's left edge (nav pl-2 +
// link pl-2) — aligned with the breadcrumb. The collapsed sidebar is
// w-12 (48px), which is exactly wide enough that 16px-from-left is also
// the visual center, so icons stay put through the width transition
// rather than sliding as the container shrinks around them.
export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <nav className="flex h-full flex-col gap-6 px-2 pt-4 pb-4">
      <NavGroup items={PRIMARY} collapsed={collapsed} className="border-b border-border pb-2" />
      <div className="flex-1" />
      <NavGroup items={SECONDARY} collapsed={collapsed} className="border-y border-border py-2" />
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex h-9 items-center gap-3",
          "rounded-md px-2",
          "text-sm text-muted-foreground",
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
  className,
}: {
  items: NavItem[];
  collapsed: boolean;
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-col gap-1", className)}>
      {items.map((item) => (
        <li key={item.to}>
          <NavLink item={item} collapsed={collapsed} />
        </li>
      ))}
    </ul>
  );
}

function NavLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
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
