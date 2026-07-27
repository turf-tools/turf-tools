// Role capabilities live in code so they ship alongside the handlers and UI
// that enforce them. Adding a Permission with a `deny` role grants it to that
// role automatically — review accordingly.

export const ROLES = ["owner", "admin", "lead"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "users.manage"
  | "datasets.manage"
  | "campaigns.write"
  | "segments.write"
  | "zones.write"
  | "turfs.publish"
  // Seeing the org's voter data at all — person-level reads, segment
  // building, exports. Field leads lack it: they run launch tables
  // (turfs board) and must never touch the file.
  | "voter.read";

type RoleSpec = "all" | { allow: Permission[] } | { deny: Permission[] };

const ROLE_PERMISSIONS: Record<string, RoleSpec> = {
  owner: "all",
  admin: { deny: ["users.manage"] },
  // Field lead: read-only turfs board, nothing else. Enforced two ways —
  // hasPermission for pages/API routes, and the RPC allowlist below for
  // the web RPC surface.
  lead: { allow: [] },
};

export function hasPermission(role: string, permission: Permission): boolean {
  const spec = ROLE_PERMISSIONS[role];
  if (!spec) return false;
  if (spec === "all") return true;
  if ("deny" in spec) return !spec.deny.includes(permission);
  return spec.allow.includes(permission);
}

// Web RPC procedures a field lead may call: the turfs board's exact read
// surface plus self-serve account settings. Enforced centrally in the
// web RPC route handler — everything else returns 403 for leads, so new
// procedures are lead-inaccessible by default.
const LEAD_RPC_ALLOWLIST = new Set([
  "healthcheck",
  "turfs.listForOrg",
  "walks.listForOrg",
  "progress.forOrg",
  "campaigns.list",
  "users.updateOwnName",
  "users.updateOwnDisplayTimezone",
]);

export function canCallRpc(role: string, procedure: string): boolean {
  if (role === "lead") return LEAD_RPC_ALLOWLIST.has(procedure);
  return true;
}
