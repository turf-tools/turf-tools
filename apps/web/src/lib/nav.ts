import type { IconName } from "~/lib/icon-names";
import { hasPermission, type Permission } from "~/lib/permissions";

export type NavItem = {
  to: string;
  label: string;
  icon: IconName;
  requires?: Permission | readonly Permission[];
};

// A tab requires every permission it calls today, so a role that can see a
// tab can use all of it. The list shrinks as a tab learns to hide what a
// role can't do.
export const PRIMARY: NavItem[] = [
  {
    to: "/$orgSlug/overview",
    label: "Overview",
    icon: "layout-dashboard",
    requires: [
      "campaigns.read",
      "segments.read",
      "scripts.read",
      "turfs.read",
      "progress.read",
      "results.read",
    ],
  },
  {
    to: "/$orgSlug/campaigns",
    label: "Campaigns",
    icon: "megaphone",
    requires: [
      "campaigns.read",
      "campaigns.write",
      "datasets.read",
      "segments.read",
      "zones.read",
      "scripts.read",
      "turfs.read",
      "turfs.cut",
      "turfs.publish",
      "persons.read",
      "results.read",
    ],
  },
  {
    to: "/$orgSlug/segments",
    label: "Segments",
    icon: "layers",
    requires: ["segments.read", "segments.write", "datasets.read", "scripts.read", "persons.read"],
  },
  {
    to: "/$orgSlug/zones",
    label: "Zones",
    icon: "waypoints",
    requires: [
      "zones.read",
      "zones.write",
      "datasets.read",
      "segments.read",
      "persons.read",
      "results.read",
    ],
  },
  {
    to: "/$orgSlug/turfs",
    label: "Turfs",
    icon: "map",
    requires: ["turfs.read", "campaigns.read", "walks.read", "walks.write"],
  },
  {
    to: "/$orgSlug/progress",
    label: "Progress",
    icon: "trending-up",
    requires: [
      "progress.read",
      "datasets.read",
      "campaigns.read",
      "segments.read",
      "zones.read",
      "results.read",
    ],
  },
  {
    to: "/$orgSlug/lookup",
    label: "Lookup",
    icon: "search",
    requires: ["persons.read", "datasets.read"],
  },
  {
    to: "/$orgSlug/scripts",
    label: "Scripts",
    icon: "clipboard-pen",
    requires: ["scripts.read", "scripts.write"],
  },
  {
    to: "/$orgSlug/questions",
    label: "Questions",
    icon: "check-check",
    requires: ["scripts.read", "scripts.write"],
  },
  {
    to: "/$orgSlug/results",
    label: "Results",
    icon: "chart-no-axes-column",
    requires: [
      "results.read",
      "datasets.read",
      "campaigns.read",
      "segments.read",
      "zones.read",
      "scripts.read",
    ],
  },
  {
    to: "/$orgSlug/reports",
    label: "Reports",
    icon: "files",
    requires: ["reports.read", "datasets.read", "campaigns.read"],
  },
];

export const SECONDARY: NavItem[] = [
  { to: "/$orgSlug/users", label: "Users", icon: "users", requires: "users.manage" },
  {
    to: "/$orgSlug/data",
    label: "Data",
    icon: "database",
    requires: ["datasets.read", "datasets.manage"],
  },
  { to: "/$orgSlug/settings", label: "Settings", icon: "settings" },
  { to: "/$orgSlug/account", label: "Account", icon: "circle-user" },
];

export function visibleNavItems(items: NavItem[], role: string | null): NavItem[] {
  return items.filter((i) => !i.requires || (role != null && hasPermission(role, i.requires)));
}

// Where a role lands when it opens the org or a tab it can't see.
export function homeNavItem(role: string | null): NavItem {
  return visibleNavItems(PRIMARY, role)[0] ?? visibleNavItems(SECONDARY, role)[0];
}
