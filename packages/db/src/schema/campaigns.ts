import { text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./app";
import { datasets } from "./datasets";
import { organizations } from "./organizations";
import { scripts } from "./scripts";
import { segments } from "./segments";
import { users } from "./auth/users";
import { zoneGroups } from "./zone-groups";

// A campaign glues together a script, a segment, and an optional zone
// group for a fixed run of work (startsAt/endsAt). Turfs are cut within
// the campaign's zones, or against the whole segment when zoneless.
export const campaigns = app.table("campaigns", {
  campaignId: uuid().defaultRandom().primaryKey(),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.organizationId),
  // Set at creation from the org's active dataset.
  datasetId: uuid()
    .notNull()
    .references(() => datasets.datasetId),
  name: text().notNull(),
  startsAt: timestamp({ withTimezone: true }),
  endsAt: timestamp({ withTimezone: true }),
  segmentId: uuid()
    .notNull()
    .references(() => segments.segmentId),
  zoneGroupId: uuid().references(() => zoneGroups.zoneGroupId),
  scriptId: uuid()
    .notNull()
    .references(() => scripts.scriptId),
  createdBy: uuid()
    .notNull()
    .references(() => users.id),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  // Soft retirement: archived campaigns disappear from active lists and
  // their turfs drop out of the turfs view, but nothing is deleted and
  // turf codes keep working. Unarchive restores everything.
  archivedAt: timestamp({ withTimezone: true }),
});
