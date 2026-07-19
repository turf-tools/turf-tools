import { ORPCError, os } from "@orpc/server";
import { and, eq, isNull, SEEDED_ADMIN_USER_ID, type Db } from "@turf-tools/db";
import { memberships, organizations, users } from "@turf-tools/db/schema";
import { auth } from "~/lib/auth";
import { hasPermission, type Permission } from "~/lib/permissions";

export type User = typeof users.$inferSelect;

// --- Web tier: authenticated, scoped to a single membership/org ---

export type WebContext = {
  db: Db;
  user: User;
  organizationId: string;
  orgSlug: string;
  role: string;
};

// Resolve the (user, org, role) for an incoming web call. The orgSlug is the
// URL-authoritative org context (extracted from the API route's `$orgSlug`
// param). Throws UNAUTHORIZED for no session, FORBIDDEN when the user isn't
// a member of the requested org.
//
// `AUTH_DISABLED=1` short-circuits to the seeded admin; their membership in
// the requested org is still required.
export async function buildWebContext(
  db: Db,
  headers: Headers,
  orgSlug: string,
): Promise<WebContext> {
  const userId = await resolveUserId(headers);
  if (!userId) throw new ORPCError("UNAUTHORIZED");
  const ctx = await loadMembership(db, userId, orgSlug);
  if (!ctx) throw new ORPCError("FORBIDDEN", { message: `No membership in org "${orgSlug}".` });
  // Dev-only role override.
  if (process.env.AUTH_DISABLED === "1" && process.env.AUTH_DISABLED_ROLE) {
    return { ...ctx, role: process.env.AUTH_DISABLED_ROLE };
  }
  return ctx;
}

async function resolveUserId(headers: Headers): Promise<string | null> {
  if (process.env.AUTH_DISABLED === "1") return SEEDED_ADMIN_USER_ID;
  const session = await auth.api.getSession({ headers });
  return session?.user.id ?? null;
}

async function loadMembership(db: Db, userId: string, orgSlug: string): Promise<WebContext | null> {
  const userRow = (await db.select().from(users).where(eq(users.id, userId)))[0];
  if (!userRow) return null;
  const row = (
    await db
      .select({
        organizationId: memberships.organizationId,
        role: memberships.role,
        orgSlug: organizations.slug,
      })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.organizationId, organizations.organizationId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(organizations.slug, orgSlug),
          isNull(memberships.archivedAt),
        ),
      )
  )[0];
  if (!row) return null;
  return {
    db,
    user: userRow,
    organizationId: row.organizationId,
    orgSlug: row.orgSlug,
    role: row.role,
  };
}

export const webBase = os.$context<WebContext>();
export const webPub = webBase.route({ method: "GET" });
export const webMut = webBase.route({ method: "POST" });

export function checkPermission(ctx: WebContext, permission: Permission) {
  if (!hasPermission(ctx.role, permission)) {
    throw new ORPCError("FORBIDDEN");
  }
}

// --- Native tier: anonymous, capability-based per turfId ---

export type NativeContext = { db: Db };

export const nativeBase = os.$context<NativeContext>();
export const nativePub = nativeBase.route({ method: "GET" });
export const nativeMut = nativeBase.route({ method: "POST" });
