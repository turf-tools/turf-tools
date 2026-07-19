import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { and, db, eq, isNull, SEEDED_ADMIN_USER_ID } from "@turf-tools/db";
import { memberships, organizations } from "@turf-tools/db/schema";
import { auth } from "~/lib/auth";

async function currentUserId(): Promise<string | null> {
  if (process.env.AUTH_DISABLED === "1") return SEEDED_ADMIN_USER_ID;
  const headers = new Headers(getRequestHeaders());
  const session = await auth.api.getSession({ headers });
  return session?.user.id ?? null;
}

// Bumps `memberships.lastAccessedAt` for the (current user, orgSlug) pair.
// Called fire-and-forget from `$orgSlug.beforeLoad` so navigation isn't
// blocked on the write. Skipped for single-org users (the "/" redirector
// has only one choice regardless). Silently no-ops if the user isn't a
// member of the requested org — the route's own check will redirect them.
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
