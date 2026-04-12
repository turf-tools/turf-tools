import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { campaigns } from "./campaigns";
import { organizations } from "./organizations";
import { users } from "./users";

export const universes = pgTable("universes", {
  universeId: uuid().defaultRandom().primaryKey(),
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
