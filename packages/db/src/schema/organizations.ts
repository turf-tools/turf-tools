import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  organizationId: uuid().defaultRandom().primaryKey(),
  // URL/SQL-safe identifier used for things like DuckLake table namespacing
  // (e.g. `{slug}_persons` in apps/data). Also handy for future URL routes.
  slug: text().notNull().unique(),
  name: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
