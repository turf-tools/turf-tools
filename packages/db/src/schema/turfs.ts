import { jsonb, pgTable, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { campaigns } from "./campaigns";
import { scripts } from "./scripts";
import { universes } from "./universes";
import { users } from "./users";

export const turfs = pgTable("turfs", {
  turfId: uuid().defaultRandom().primaryKey(),
  campaignId: uuid()
    .notNull()
    .references(() => campaigns.campaignId),
  universeId: uuid()
    .notNull()
    .references(() => universes.universeId),
  scriptId: uuid()
    .notNull()
    .references(() => scripts.scriptId),
  name: text().notNull(),
  geometry: jsonb(),
  doors: integer(),
  people: integer(),
  assignedTo: uuid().references(() => users.userId),
  createdBy: uuid()
    .notNull()
    .references(() => users.userId),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
