import { ORPCError, os } from "@orpc/server";
import { and, eq, isNull, SEEDED_ADMIN_USER_ID, type Db } from "@field-tools/db";
import { memberships, organizations, users } from "@field-tools/db/schema";
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

// Resolve the (user, org, role) for an incoming web call. Throws
// UNAUTHORIZED when no valid session exists or the user has no membership.
//
// `AUTH_DISABLED=1` short-circuits to the seeded admin + its owner membership
// — for local dev when you don't want to exercise the magic-link flow.
export async function buildWebContext(db: Db, headers: Headers): Promise<WebContext> {
  if (process.env.AUTH_DISABLED === "1") {
    const ctx = await loadFromUserId(db, SEEDED_ADMIN_USER_ID);
    if (!ctx) {
      throw new Error("AUTH_DISABLED=1 but seeded admin not found; run `pnpm db:mock`.");
    }
    // Dev-only role override — set `AUTH_DISABLED_ROLE=admin` to simulate a
    // different role without exercising magic-link auth.
    if (process.env.AUTH_DISABLED_ROLE) {
      return { ...ctx, role: process.env.AUTH_DISABLED_ROLE };
    }
    return ctx;
  }

  const session = await auth.api.getSession({ headers });
  if (!session) throw new ORPCError("UNAUTHORIZED");
  const ctx = await loadFromUserId(db, session.user.id);
  if (!ctx) throw new ORPCError("UNAUTHORIZED");
  return ctx;
}

async function loadFromUserId(db: Db, userId: string): Promise<WebContext | null> {
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
      .where(and(eq(memberships.userId, userId), isNull(memberships.archivedAt)))
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
