import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./auth/users";

// A segment is a targeting set defined by criteria over the voter file —
// e.g., "Swing Voters", "Base Voters", "Bushwick North". Standalone and
// reusable across campaigns.
export const segments = pgTable("segments", {
  segmentId: uuid().defaultRandom().primaryKey(),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.organizationId),
  name: text().notNull(),
  criteria: jsonb(),
  voterFileId: text(),
  voterFileVersion: integer(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.id),
  doorCount: integer(),
  personCount: integer(),
});
