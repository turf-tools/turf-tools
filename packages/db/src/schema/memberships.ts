import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./auth/users";

// One row per (user, org) pair. `role` is a free-form text value enforced in
// application code.

export const memberships = pgTable(
  "memberships",
  {
    membershipId: uuid().defaultRandom().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.organizationId),
    role: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp({ withTimezone: true }),
    // Bumped on each visit to a /$orgSlug/... route; powers the "/" landing
    // redirect (most-recently-used org) for multi-membership users.
    lastAccessedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("memberships_user_org").on(t.userId, t.organizationId)],
);
