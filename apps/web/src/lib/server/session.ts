import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { db, eq, SEEDED_ADMIN_USER_ID } from "@field-tools/db";
import { users } from "@field-tools/db/schema";
import { auth } from "~/lib/auth";

export type SessionUser = { id: string; email: string; name: string | null };

// Lookup the active session for the incoming request. Returns null when no
// session exists. `AUTH_DISABLED=1` short-circuits to the seeded admin
// (loaded from the DB so the values agree with `buildWebContext`).
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
      setResponseHeader("Cache-Control", "no-store");
      return { user: { id: row.id, email: row.email, name: row.name ?? null } };
    }
    const headers = new Headers(getRequestHeaders());
    const session = await auth.api.getSession({ headers });
    if (!session) return null;
    setResponseHeader("Cache-Control", "no-store");
    return {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name ?? null,
      },
    };
  },
);
