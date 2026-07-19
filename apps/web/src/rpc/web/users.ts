import { ORPCError } from "@orpc/server";
import { and, asc, eq, isNull, sql, type Db } from "@turf-tools/db";
import { memberships, users } from "@turf-tools/db/schema";
import { z } from "zod";
import { auth } from "~/lib/auth";
import { normalizeEmail } from "~/lib/normalize-email";
import { ROLES } from "~/lib/permissions";
import { checkPermission, webMut, webPub } from "../context";

const roleSchema = z.enum(ROLES);

async function countActiveOwners(db: Db, organizationId: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.role, "owner"),
        isNull(memberships.archivedAt),
      ),
    );
  return result[0]?.count ?? 0;
}

// List memberships in the current org. Status is derived per-row:
//   archived → membership has archivedAt set
//   active   → users.emailVerified (BA flips this on first OTP verify)
//   pending  → invite sent, never verified
export const list = webPub.input(z.object({}).optional()).handler(async ({ context }) => {
  const rows = await context.db
    .select({
      userId: users.id,
      email: users.displayEmail,
      name: users.name,
      emailVerified: users.emailVerified,
      role: memberships.role,
      joinedAt: memberships.createdAt,
      archivedAt: memberships.archivedAt,
      lastLogin: users.lastLoginAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.organizationId, context.organizationId))
    .orderBy(asc(memberships.createdAt));

  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    name: r.name,
    role: r.role,
    joinedAt: r.joinedAt,
    lastLogin: r.lastLogin,
    status: (r.archivedAt ? "archived" : r.emailVerified ? "active" : "pending") as
      | "archived"
      | "active"
      | "pending",
  }));
});

// Invite a user by email. Throws CONFLICT if a membership already exists —
// archived members must be restored via `unarchive`, not re-invited.
export const invite = webMut
  .input(
    z.object({
      email: z.string().email().trim(),
      name: z.string().trim().min(1).max(120).optional(),
      role: roleSchema,
      sendEmail: z.boolean().default(true),
    }),
  )
  .handler(async ({ context, input }) => {
    checkPermission(context, "users.manage");

    const email = normalizeEmail(input.email);
    const displayEmail = input.email.toLowerCase();

    const existing = (
      await context.db
        .select({ archivedAt: memberships.archivedAt })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(users.email, email), eq(memberships.organizationId, context.organizationId)))
    )[0];
    if (existing) {
      throw new ORPCError("CONFLICT", {
        message: existing.archivedAt
          ? "User is an archived member — unarchive them instead"
          : "User is already a member",
      });
    }

    const name = input.name ?? displayEmail.split("@")[0]!;
    const inserted = await context.db
      .insert(users)
      .values({ email, displayEmail, name })
      .returning({ id: users.id });
    const userId = inserted[0]!.id;
    await context.db.insert(memberships).values({
      userId,
      organizationId: context.organizationId,
      role: input.role,
    });

    if (input.sendEmail) {
      await auth.api.sendVerificationOTP({
        body: { email: displayEmail, type: "sign-in" },
        headers: new Headers(),
      });
    }

    return { ok: true as const, userId };
  });

// Change a member's role. Blocks role changes on archived members and
// demoting the only active owner.
export const updateRole = webMut
  .input(z.object({ userId: z.string().uuid(), role: roleSchema }))
  .handler(async ({ context, input }) => {
    checkPermission(context, "users.manage");

    const membership = (
      await context.db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, input.userId),
            eq(memberships.organizationId, context.organizationId),
          ),
        )
    )[0];
    if (!membership) throw new ORPCError("NOT_FOUND");
    if (membership.archivedAt) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Cannot change role of an archived member",
      });
    }

    if (membership.role === "owner" && input.role !== "owner") {
      const ownerCount = await countActiveOwners(context.db, context.organizationId);
      if (ownerCount <= 1) {
        throw new ORPCError("BAD_REQUEST", { message: "Cannot demote the only user" });
      }
    }

    await context.db
      .update(memberships)
      .set({ role: input.role })
      .where(eq(memberships.membershipId, membership.membershipId));

    return { ok: true as const };
  });

// Archive a membership. Self-archive and last-active-owner archive are blocked.
export const archive = webMut
  .input(z.object({ userId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    checkPermission(context, "users.manage");

    if (input.userId === context.user.id) {
      throw new ORPCError("BAD_REQUEST", { message: "Cannot archive yourself" });
    }

    const membership = (
      await context.db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, input.userId),
            eq(memberships.organizationId, context.organizationId),
          ),
        )
    )[0];
    if (!membership) throw new ORPCError("NOT_FOUND");
    if (membership.archivedAt) return { ok: true as const };

    if (membership.role === "owner") {
      const ownerCount = await countActiveOwners(context.db, context.organizationId);
      if (ownerCount <= 1) {
        throw new ORPCError("BAD_REQUEST", { message: "Cannot archive the only user" });
      }
    }

    await context.db
      .update(memberships)
      .set({ archivedAt: new Date() })
      .where(eq(memberships.membershipId, membership.membershipId));

    return { ok: true as const };
  });

// Restore an archived membership.
export const unarchive = webMut
  .input(z.object({ userId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    checkPermission(context, "users.manage");

    const membership = (
      await context.db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, input.userId),
            eq(memberships.organizationId, context.organizationId),
          ),
        )
    )[0];
    if (!membership) throw new ORPCError("NOT_FOUND");
    if (!membership.archivedAt) return { ok: true as const };

    await context.db
      .update(memberships)
      .set({ archivedAt: null })
      .where(eq(memberships.membershipId, membership.membershipId));

    return { ok: true as const };
  });

// Re-send the login email for an active member of this org.
export const resendInvite = webMut
  .input(z.object({ userId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    checkPermission(context, "users.manage");

    const row = (
      await context.db
        .select({ displayEmail: users.displayEmail })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.userId, input.userId),
            eq(memberships.organizationId, context.organizationId),
            isNull(memberships.archivedAt),
          ),
        )
    )[0];
    if (!row) throw new ORPCError("NOT_FOUND");

    await auth.api.sendVerificationOTP({
      body: { email: row.displayEmail, type: "sign-in" },
      headers: new Headers(),
    });

    return { ok: true as const };
  });

// Self-service name edit for the Account page. No permission gate — anyone
// can update their own display name.
export const updateOwnName = webMut
  .input(z.object({ name: z.string().trim().min(1).max(120) }))
  .handler(async ({ context, input }) => {
    await context.db
      .update(users)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(users.id, context.user.id));

    return { ok: true as const };
  });

// Persist the user's display timezone. Called by the root layout on first
// authed mount (auto-detect) and by the Account page (manual override).
// Validates against the curated TIMEZONE_OPTIONS list — IANA strings outside
// it are rejected to keep storage tidy.
export const updateOwnDisplayTimezone = webMut
  .input(
    z.object({
      displayTimezone: z.enum([
        "America/New_York",
        "America/Chicago",
        "America/Denver",
        "America/Los_Angeles",
      ]),
    }),
  )
  .handler(async ({ context, input }) => {
    await context.db
      .update(users)
      .set({ displayTimezone: input.displayTimezone, updatedAt: new Date() })
      .where(eq(users.id, context.user.id));

    return { ok: true as const };
  });
