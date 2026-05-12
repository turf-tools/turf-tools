import { ORPCError, os } from "@orpc/server";
import { eq, SEEDED_ADMIN_USER_ID, type Db } from "@field-tools/db";
import { memberships, organizations, users } from "@field-tools/db/schema";
import { auth } from "~/lib/auth";

export type User = typeof users.$inferSelect;

// --- Admin tier: authenticated, scoped to a single membership/org ---

export type AdminContext = {
  db: Db;
  user: User;
  organizationId: string;
  orgSlug: string;
  role: string;
};

// Resolve the (user, org, role) for an incoming admin call. Throws
// UNAUTHORIZED when no valid session exists or the user has no membership.
//
// `AUTH_DISABLED=1` short-circuits to the seeded admin + its owner membership
// — for local dev when you don't want to exercise the magic-link flow.
export async function buildAdminContext(db: Db, headers: Headers): Promise<AdminContext> {
  if (process.env.AUTH_DISABLED === "1") {
    const ctx = await loadAdminFromUserId(db, SEEDED_ADMIN_USER_ID);
    if (!ctx) {
      throw new Error("AUTH_DISABLED=1 but seeded admin not found; run `pnpm db:mock`.");
    }
    return ctx;
  }

  const session = await auth.api.getSession({ headers });
  if (!session) throw new ORPCError("UNAUTHORIZED");
  const ctx = await loadAdminFromUserId(db, session.user.id);
  if (!ctx) throw new ORPCError("UNAUTHORIZED");
  return ctx;
}

async function loadAdminFromUserId(db: Db, userId: string): Promise<AdminContext | null> {
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
      .where(eq(memberships.userId, userId))
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

export const adminBase = os.$context<AdminContext>();
export const adminPub = adminBase.route({ method: "GET" });
export const adminMut = adminBase.route({ method: "POST" });

// --- Native tier: anonymous, capability-based per turfId ---

export type NativeContext = { db: Db };

export const nativeBase = os.$context<NativeContext>();
export const nativePub = nativeBase.route({ method: "GET" });
export const nativeMut = nativeBase.route({ method: "POST" });
