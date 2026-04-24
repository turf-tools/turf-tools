import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

// A zone is a named spatial region (e.g. a neighborhood or precinct) used to
// scope turf cutting. Geometry fields are intentionally omitted for now —
// the spatial representation (polygon, TIGER blockface set, etc.) will get
// nailed down once the cutter UI is further along.
export const zones = pgTable("zones", {
  zoneId: uuid().defaultRandom().primaryKey(),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.organizationId),
  name: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.userId),
});
