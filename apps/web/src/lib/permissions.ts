// Role capabilities live in code so they ship alongside the handlers and UI
// that enforce them. Adding a Permission with a `deny` role grants it to that
// role automatically — review accordingly.

export const ROLES = ["owner", "admin"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "users.manage"
  | "campaigns.write"
  | "segments.write"
  | "zones.write"
  | "turfs.publish";

type RoleSpec = "all" | { allow: Permission[] } | { deny: Permission[] };

const ROLE_PERMISSIONS: Record<string, RoleSpec> = {
  owner: "all",
  admin: { deny: ["users.manage"] },
};

export function hasPermission(role: string, permission: Permission): boolean {
  const spec = ROLE_PERMISSIONS[role];
  if (!spec) return false;
  if (spec === "all") return true;
  if ("deny" in spec) return !spec.deny.includes(permission);
  return spec.allow.includes(permission);
}
