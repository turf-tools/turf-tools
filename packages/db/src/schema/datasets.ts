import {
  type AnyPgColumn,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./auth/users";

// A dataset is a deployment-level source of canvassable persons (a state voter
// file, a union roster, …). NOT org-scoped — orgs *reference* it via
// `datasetOrganizations`, so one dataset can be shared across orgs on a
// deployment (upload once, update once → all referencing orgs move together).
// Data lives once per version, each version in its own DuckLake schema
// (`ducklake.<slug>_v<versionNumber>`). See docs/plans/dataset-import-model.md.
export const datasets = pgTable(
  "datasets",
  {
    datasetId: uuid().defaultRandom().primaryKey(),
    // snake_case, unique per deployment. The per-version DuckLake schema name
    // derives as `${slug}_v${versionNumber}` (e.g. `nys_voter_file_v1`), so
    // slug is effectively immutable — a rename means renaming those schemas.
    slug: text().notNull(),
    name: text().notNull(),
    // The version segments float to. Null until the first import completes.
    // Circular with `datasetVersions.datasetId`; nullable so inserts don't
    // deadlock (create dataset → create version → point active at it).
    activeVersionId: uuid().references((): AnyPgColumn => datasetVersions.datasetVersionId),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("datasets_slug").on(t.slug)],
);

export type DatasetVersionStatus = "importing" | "ready" | "failed";

// An immutable, retained version of a dataset. Never deleted, so any pinned
// reference (a published turf, a canvass event) always resolves. Its data lives
// in the DuckLake schema `${dataset.slug}_v${versionNumber}`. `manifest` is the
// field catalog (what's filterable/zonable — the serialized importer Manifest).
export const datasetVersions = pgTable(
  "dataset_versions",
  {
    datasetVersionId: uuid().defaultRandom().primaryKey(),
    datasetId: uuid()
      .notNull()
      .references(() => datasets.datasetId),
    versionNumber: integer().notNull(),
    manifest: jsonb(),
    sourceUri: text(),
    rowCount: integer(),
    status: text().$type<DatasetVersionStatus>().notNull().default("importing"),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid().references(() => users.id),
  },
  (t) => [uniqueIndex("dataset_versions_number").on(t.datasetId, t.versionNumber)],
);

// Access grant: which orgs can reference a dataset. Two rows on one dataset =
// shared. Active version stays on the dataset (shared orgs move together); a
// per-org `activeVersionOverride` could land here later for staged rollout.
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
