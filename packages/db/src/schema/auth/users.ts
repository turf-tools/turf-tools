import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Better Auth managed. The PK property must be `id` because BA's drizzle
// introspection hard-codes that name — all four tables in `schema/auth/`
// follow this constraint. Elsewhere in the schema we use `<table>Id`.

export const users = pgTable(
  "users",
  {
    id: uuid().defaultRandom().primaryKey(),
    email: text().notNull(),
    emailVerified: boolean().notNull().default(false),
    name: text().notNull(),
    image: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    // Set on each successful sign-in via BA's session.create.after
    // hook (see lib/auth.ts). Independent of sessions, which BA deletes
    // on sign-out. Read-only from BA's perspective.
    lastLoginAt: timestamp({ withTimezone: true }),
    // IANA TZ string used by the admin UI to render dates in the user's
    // own clock. Null until the client auto-detects on first authed mount
    // (see root layout) and persists via users.updateOwnDisplayTimezone.
    displayTimezone: text(),
  },
  (t) => [uniqueIndex("users_email").on(t.email)],
);
