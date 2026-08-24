import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { and, db, eq, isNull, SEEDED_ADMIN_USER_ID } from "@turf-tools/db";
import { memberships, organizations, users } from "@turf-tools/db/schema";
import { auth } from "~/lib/auth";
import { timed } from "~/lib/server/timing";

export type SessionOrg = {
  organizationId: string;
  orgSlug: string;
  orgName: string;
  role: string;
  lastAccessedAt: Date | null;
};

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  // Temporary: until $orgSlug-aware chrome lands, kept for the existing
  // `session.user.role` consumers. Will be removed once chrome derives role
  // from `orgsBySlug[currentOrgSlug]`.
  role: string;
  displayTimezone: string | null;
};

async function loadOrgsBySlug(userId: string): Promise<Record<string, SessionOrg>> {
  const rows = await db
    .select({
      organizationId: memberships.organizationId,
      orgSlug: organizations.slug,
      orgName: organizations.name,
      role: memberships.role,
      lastAccessedAt: memberships.lastAccessedAt,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.organizationId))
    .where(and(eq(memberships.userId, userId), isNull(memberships.archivedAt)));
  return Object.fromEntries(rows.map((r) => [r.orgSlug, r]));
}

// Lookup the active session for the incoming request. Returns null when no
// session exists or when the user has no active (non-archived) membership.
// `AUTH_DISABLED=1` short-circuits to the seeded admin; `AUTH_DISABLED_ROLE`
// overrides the role string (dev only) — see buildWebContext for the matching
// RPC-side behavior so client and server stay in sync.
//
// Authenticated SSR responses are marked `Cache-Control: no-store` so the
// browser opts out of bfcache on these pages.
export const getSession = createServerFn({ method: "GET" }).handler(
  (): Promise<{
    user: SessionUser;
    orgsBySlug: Record<string, SessionOrg>;
  } | null> =>
    // `auth` in the SSR Server-Timing breakdown (see src/server.ts).
    timed("auth", async () => {
      if (process.env.AUTH_DISABLED === "1") {
        const row = (await db.select().from(users).where(eq(users.id, SEEDED_ADMIN_USER_ID)))[0];
        if (!row) {
          throw new Error("AUTH_DISABLED=1 but seeded admin not found; run `pnpm db:mock`.");
        }
        const orgsBySlug = await loadOrgsBySlug(row.id);
        const first = Object.values(orgsBySlug)[0];
        if (!first) return null;
        const role = process.env.AUTH_DISABLED_ROLE ?? first.role;
        setResponseHeader("Cache-Control", "no-store");
        return {
          user: {
            id: row.id,
            email: row.displayEmail,
            name: row.name,
            role,
            displayTimezone: row.displayTimezone,
          },
          orgsBySlug,
        };
      }
      // no-store on every branch — a cached null (or stale session) served
      // to a route guard would misroute navigation.
      setResponseHeader("Cache-Control", "no-store");
      const headers = new Headers(getRequestHeaders());
      const session = await auth.api.getSession({ headers });
      if (!session) return null;
      const orgsBySlug = await loadOrgsBySlug(session.user.id);
      const first = Object.values(orgsBySlug)[0];
      if (!first) return null;
      const userRow = (
        await db
          .select({ displayEmail: users.displayEmail, displayTimezone: users.displayTimezone })
          .from(users)
          .where(eq(users.id, session.user.id))
      )[0];
      setResponseHeader("Cache-Control", "no-store");
      return {
        user: {
          id: session.user.id,
          email: userRow?.displayEmail ?? session.user.email,
          name: session.user.name,
          role: first.role,
          displayTimezone: userRow?.displayTimezone ?? null,
        },
        orgsBySlug,
      };
    }),
);
