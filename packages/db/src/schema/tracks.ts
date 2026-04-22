import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

// A track is a phase or line of work within an organization — e.g.,
// "Persuasion", "GOTV", "Membership Drive". It's the session-level scope
// most admin UI views filter by. (Formerly called a "campaign"; the word
// is reserved here for the organization itself, like "Claire Valdez for
// Congress".)
export const tracks = pgTable("tracks", {
  trackId: uuid().defaultRandom().primaryKey(),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.organizationId),
  name: text().notNull(),
  startsAt: timestamp({ withTimezone: true }),
  endsAt: timestamp({ withTimezone: true }),
  createdBy: uuid()
    .notNull()
    .references(() => users.userId),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
