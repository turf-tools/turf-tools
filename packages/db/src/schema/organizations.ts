import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const organizations = pgTable(
  "organizations",
  {
    organizationId: uuid().defaultRandom().primaryKey(),
    // URL/SQL-safe identifier — appears in page URLs (/<slug>/...), API
    // paths (/api/web/<slug>/...), and DuckLake schema names
    // (ducklake.<slug>.*). The CHECK below enforces URL/SQL safety at
    // the only layer nothing can bypass.
    slug: text().notNull().unique(),
    name: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Lowercase + digits + internal hyphens, start/end alphanumeric.
    // Rejects spaces, uppercase, leading/trailing/double hyphens.
    check("slug_format", sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'`),
  ],
);
