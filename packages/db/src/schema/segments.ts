import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

// A segment is a targeting set defined by a query over the voter file —
// e.g., "Swing Voters", "Base Voters", "Bushwick North". Standalone and
// reusable across campaigns. Queries can compose by referencing other
// segments, so a campaign-level "universe" can be built up from leaves.
export const segments = pgTable("segments", {
  segmentId: uuid().defaultRandom().primaryKey(),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.organizationId),
  name: text().notNull(),
  query: jsonb(),
  voterFileId: text(),
  voterFileVersion: integer(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.userId),
  doorCount: integer(),
  personCount: integer(),
});
