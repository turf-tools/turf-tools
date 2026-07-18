import { pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { datasets } from "./datasets";
import { organizations } from "./organizations";

// Access grant: which orgs can reference a dataset. Two rows on one dataset =
// shared. Gates visibility only — the active version is per-org
// (`organizations.activeDatasetVersionId`), so shared orgs activate independently.
// Lives in its own file (like `memberships`) so `datasets` needn't import
// `organizations`, keeping the two entity modules free of an import cycle.
export const datasetOrganizations = pgTable(
  "dataset_organizations",
  {
    datasetOrganizationId: uuid().defaultRandom().primaryKey(),
    datasetId: uuid()
      .notNull()
      .references(() => datasets.datasetId),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.organizationId),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("dataset_organizations_dataset_org").on(t.datasetId, t.organizationId)],
);
