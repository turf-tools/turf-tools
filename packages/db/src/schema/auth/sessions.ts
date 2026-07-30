import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { app } from "../app";
import { users } from "./users";

// Better Auth session row. Cookie holds the opaque `token`; server looks up
// the session per request.

export const sessions = app.table(
  "sessions",
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("sessions_token").on(t.token)],
);
