import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth/users";
import { zoneGroups } from "./zone-groups";

// A zone is a named set of administrative-unit keys (e.g. EDs, ZIPs)
// within a zone group. The key type is determined by the parent
// `zone_groups.keyGroup` — every zone in a group shares the same unit type.
// Polygons and counts are derived server-side from `keys`; this table only
// stores the selection.
export const zones = pgTable("zones", {
  zoneId: uuid().defaultRandom().primaryKey(),
  zoneGroupId: uuid()
    .notNull()
    .references(() => zoneGroups.zoneGroupId, { onDelete: "cascade" }),
  name: text().notNull(),
  // Opaque key identifiers, scoped to the parent group's keyGroup.
  // e.g. for "nyc_eds": ["36-65-39", "36-65-40", ...]
  keys: jsonb().$type<string[]>().notNull().default([]),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.id),
});
