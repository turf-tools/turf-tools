import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Better Auth verification row. Magic-link tokens land here and get consumed
// on click.

export const verifications = pgTable("verifications", {
  id: uuid().defaultRandom().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
