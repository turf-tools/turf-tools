import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { datasets } from "./datasets";
import { organizations } from "./organizations";
import { users } from "./auth/users";

// A segment is a targeting set defined by criteria over a dataset's persons —
// e.g., "Swing Voters", "Base Voters", "Bushwick North". Standalone and
// reusable across campaigns.
export const segments = pgTable("segments", {
  segmentId: uuid().defaultRandom().primaryKey(),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.organizationId),
  name: text().notNull(),
  criteria: jsonb(),
  // The dataset this segment filters. It *floats* — evaluated against the
  // dataset's active version at query time (no version pinned here; that's the
  // turf's job). See docs/plans/dataset-import-model.md.
  datasetId: uuid().references(() => datasets.datasetId),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.id),
  doorCount: integer(),
  personCount: integer(),
});
