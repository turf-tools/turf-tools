import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { datasets } from "./datasets";
import { organizations } from "./organizations";
import { users } from "./auth/users";

// A zone group is the parent container for a set of zones. Each group is
// pinned to one key group (e.g. "nyc_eds", "zip5") — the type of
// administrative unit the zones inside it are built from. Switching key
// group means making a new zone group, not editing this one.
//
// Most orgs will only ever have one zone group. The abstraction exists for
// the rare case where an org needs more than one zoning (different key
// types, or alternative partitions for different campaigns).
export const zoneGroups = pgTable("zone_groups", {
  zoneGroupId: uuid().defaultRandom().primaryKey(),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.organizationId),
  datasetId: uuid().references(() => datasets.datasetId),
  name: text().notNull(),
  // Opaque identifier resolved by the data service (e.g. "nyc_eds").
  // Web doesn't interpret this; it's the contract with apps/data.
  keyGroup: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.id),
});
