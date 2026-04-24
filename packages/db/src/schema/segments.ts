import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { campaigns } from "./campaigns";
import { organizations } from "./organizations";
import { users } from "./users";

// A segment is a targeting set defined by a query over the voter file —
// e.g., "Swing Voters", "Base Voters", "Bushwick North". Currently attached
// to a campaign via FK, though the longer-term model is for segments to be
// standalone, with campaigns pointing at them instead.
export const segments = pgTable("segments", {
  segmentId: uuid().defaultRandom().primaryKey(),
  campaignId: uuid()
    .notNull()
    .references(() => campaigns.campaignId),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.organizationId),
  name: text().notNull(),
  query: jsonb(),
  voterFileId: text(),
  voterFileVersion: integer(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.userId),
  doorCount: integer(),
  personCount: integer(),
});
