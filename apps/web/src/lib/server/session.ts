import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { and, db, eq, isNull, SEEDED_ADMIN_USER_ID } from "@field-tools/db";
import { memberships, users } from "@field-tools/db/schema";
import { auth } from "~/lib/auth";

export type SessionUser = { id: string; email: string; name: string; role: string };

async function loadActiveRole(userId: string): Promise<string | null> {
  const row = (
    await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), isNull(memberships.archivedAt)))
      .limit(1)
  )[0];
  return row?.role ?? null;
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
  async (): Promise<{
    user: SessionUser;
  } | null> => {
    if (process.env.AUTH_DISABLED === "1") {
      const row = (await db.select().from(users).where(eq(users.id, SEEDED_ADMIN_USER_ID)))[0];
      if (!row) {
        throw new Error("AUTH_DISABLED=1 but seeded admin not found; run `pnpm db:mock`.");
      }
      const role = process.env.AUTH_DISABLED_ROLE ?? (await loadActiveRole(row.id));
      if (!role) return null;
      setResponseHeader("Cache-Control", "no-store");
      return { user: { id: row.id, email: row.email, name: row.name, role } };
    }
    const headers = new Headers(getRequestHeaders());
    const session = await auth.api.getSession({ headers });
    if (!session) return null;
    const role = await loadActiveRole(session.user.id);
    if (!role) return null;
    setResponseHeader("Cache-Control", "no-store");
    return {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        role,
      },
    };
  },
);
