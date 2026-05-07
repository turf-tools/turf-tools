import { os } from "@orpc/server";
import { eq, type Db } from "@field-tools/db";
import { users } from "@field-tools/db/schema";

// Hardcoded admin user id seeded by packages/db/src/mock.ts. Without real auth
// every RPC call resolves to this user via loadUser(). Swap this for a
// real session lookup (cookie, header, etc.) when auth is added.
export const SEEDED_ADMIN_USER_ID = "00000000-0000-4000-8000-000000000001";

export type User = typeof users.$inferSelect;

export type ORPCContext = {
  db: Db;
  user: User;
};

// Load the user that should be associated with an incoming RPC call. For now
// hardcode to a seeded admin; with real auth, the auth-derived facts
// (userId, sessionToken, etc.) will be pre-extracted into the context shape
// at the request boundary instead of carrying a Request object around.
// Throws if the seeded user doesn't exist (i.e. `pnpm db:mock` hasn't been run).
export async function loadUser(db: Db): Promise<User> {
  const rows = await db.select().from(users).where(eq(users.userId, SEEDED_ADMIN_USER_ID));
  const user = rows[0];
  if (!user) {
    throw new Error(
      "Seeded admin user not found. Run `pnpm db:mock` to populate default mock data.",
    );
  }
  return user;
}

// Base procedure with context — all procedures build on this
export const base = os.$context<ORPCContext>();

// Public read procedure (no auth required). Method is overridable per-route.
export const pub = base.route({ method: "GET" });

// Public write procedure — same context, POST method, for mutations.
export const mut = base.route({ method: "POST" });
