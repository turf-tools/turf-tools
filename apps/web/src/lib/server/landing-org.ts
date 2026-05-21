import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { and, db, desc, eq, isNull, SEEDED_ADMIN_USER_ID } from "@field-tools/db";
import { memberships, organizations } from "@field-tools/db/schema";
import { auth } from "~/lib/auth";

async function currentUserId(): Promise<string | null> {
  if (process.env.AUTH_DISABLED === "1") return SEEDED_ADMIN_USER_ID;
  const headers = new Headers(getRequestHeaders());
  const session = await auth.api.getSession({ headers });
  return session?.user.id ?? null;
}

// The "/" redirector calls this to pick the user's most-recently-used org.
// Falls back to any active membership when nothing has been accessed yet
// (e.g. just-seeded users). Returns null when the user has no active
// memberships, in which case the redirector bounces them to /login.
export const resolveLandingOrgSlug = createServerFn({ method: "GET" }).handler(
  async (): Promise<string | null> => {
    const userId = await currentUserId();
    if (!userId) return null;
    const row = (
      await db
        .select({ orgSlug: organizations.slug })
        .from(memberships)
        .innerJoin(organizations, eq(memberships.organizationId, organizations.organizationId))
        .where(and(eq(memberships.userId, userId), isNull(memberships.archivedAt)))
        .orderBy(desc(memberships.lastAccessedAt), desc(memberships.createdAt))
        .limit(1)
    )[0];
    return row?.orgSlug ?? null;
  },
);

// Bumps `memberships.lastAccessedAt` for the (current user, orgSlug) pair.
// Called fire-and-forget from `$orgSlug.beforeLoad` so navigation isn't
// blocked on the write. Silently no-ops if the user isn't a member of the
// requested org — the route's own membership check will redirect them.
export const bumpOrgLastAccessed = createServerFn({ method: "POST" })
  .inputValidator(z.object({ orgSlug: z.string() }))
  .handler(async ({ data }) => {
    const userId = await currentUserId();
    if (!userId) return;
    const org = (
      await db
        .select({ organizationId: organizations.organizationId })
        .from(organizations)
        .where(eq(organizations.slug, data.orgSlug))
        .limit(1)
    )[0];
    if (!org) return;
    await db
      .update(memberships)
      .set({ lastAccessedAt: new Date() })
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.organizationId, org.organizationId),
          isNull(memberships.archivedAt),
        ),
      );
  });
