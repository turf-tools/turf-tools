import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { scripts } from "./scripts";
import { segments } from "./segments";
import { users } from "./users";
import { zoneGroups } from "./zone-groups";

// A campaign glues together a script, a segment, and a zone group for a
// fixed run of work (startsAt/endsAt). Turfs are then cut within each of
// the campaign's zones. The three FKs are nullable because a campaign can
// be saved as a draft before all the pieces are picked; an "active"
// campaign should have all three set (enforced at the app level).
export const campaigns = pgTable("campaigns", {
  campaignId: uuid().defaultRandom().primaryKey(),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.organizationId),
  name: text().notNull(),
  startsAt: timestamp({ withTimezone: true }),
  endsAt: timestamp({ withTimezone: true }),
  segmentId: uuid().references(() => segments.segmentId),
  zoneGroupId: uuid().references(() => zoneGroups.zoneGroupId),
  scriptId: uuid().references(() => scripts.scriptId),
  createdBy: uuid()
    .notNull()
    .references(() => users.userId),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
