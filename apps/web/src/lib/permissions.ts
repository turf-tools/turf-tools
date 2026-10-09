// Roles and permissions live in code so they ship alongside the handlers and
// UI that enforce them. Every web RPC procedure and data route names the
// permission it needs; a role is a named set of permissions plus a rank.

// Read/write pairs per editing section; scripts covers the Questions tab too.
// turfs.cut is the cutter, walks are sign-outs on the board, persons.read is
// any person-level data (lookup, samples, exports, map points).
export const PERMISSIONS = [
  "datasets.read",
  "datasets.manage",
  "campaigns.read",
  "campaigns.write",
  "segments.read",
  "segments.write",
  "zones.read",
  "zones.write",
  "scripts.read",
  "scripts.write",
  "turfs.read",
  "turfs.cut",
  "turfs.publish",
  "walks.read",
  "walks.write",
  "persons.read",
  "progress.read",
  "results.read",
  "reports.read",
  "users.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

type RoleSpec = {
  rank: number;
  label: string;
  permissions: "all" | readonly Permission[];
};

export const ROLES = {
  owner: { rank: 3, label: "Owner", permissions: "all" },
  admin: { rank: 2, label: "Admin", permissions: "all" },
  lead: {
    rank: 1,
    label: "Field lead",
    permissions: ["turfs.read", "campaigns.read", "walks.read", "walks.write"],
  },
} as const satisfies Record<string, RoleSpec>;

export type Role = keyof typeof ROLES;
export const ROLE_NAMES = Object.keys(ROLES) as [Role, ...Role[]];

export function isRole(value: string): value is Role {
  return value in ROLES;
}

// Display name for any surface that shows a role. Never render the raw value.
export function roleLabel(role: string): string {
  return isRole(role) ? ROLES[role].label : role;
}

// True when the role holds every listed permission. Unknown roles hold none.
export function hasPermission(
  role: string,
  permission: Permission | readonly Permission[],
): boolean {
  if (!isRole(role)) return false;
  const held = ROLES[role].permissions;
  if (held === "all") return true;
  const wanted = typeof permission === "string" ? [permission] : permission;
  return wanted.every((p) => (held as readonly Permission[]).includes(p));
}

// Who may manage whom: a member may be managed, or a role assigned, only
// when it ranks at or below the caller's own. Equal ranks manage each
// other. The users.manage permission is checked separately.
export function canManage(actorRole: string, targetRole: string): boolean {
  if (!isRole(actorRole) || !isRole(targetRole)) return false;
  return ROLES[targetRole].rank <= ROLES[actorRole].rank;
}
