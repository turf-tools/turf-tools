import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

// A campaign is the thing that glues together a script, a segment, and a
// set of zones for a fixed run of work (startsAt/endsAt). Turfs are then
// cut within each of the campaign's zones. Segments, zones, and scripts
// themselves are standalone entities — reusable across campaigns.
export const campaigns = pgTable("campaigns", {
  campaignId: uuid().defaultRandom().primaryKey(),
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
