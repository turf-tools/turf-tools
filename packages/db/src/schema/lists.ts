import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { tracks } from "./tracks";
import { users } from "./users";

// A list is a targeting set defined by a query over the voter file —
// e.g., "Swing Voters", "Base Voters", "Bushwick North". Lists belong to
// a track. Turfs are cut from lists. (Formerly called a "universe".)
export const lists = pgTable("lists", {
  listId: uuid().defaultRandom().primaryKey(),
  trackId: uuid()
    .notNull()
    .references(() => tracks.trackId),
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
