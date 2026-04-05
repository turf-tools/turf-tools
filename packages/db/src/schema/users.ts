import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const users = pgTable("users", {
  userId: uuid().defaultRandom().primaryKey(),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.organizationId),
  email: text().notNull(),
  firstName: text().notNull(),
  lastName: text().notNull(),
  role: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
