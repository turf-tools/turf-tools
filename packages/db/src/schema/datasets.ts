import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth/users";

// A dataset is a deployment-level source of canvassable persons (a state voter
// file, a union roster, …). NOT org-scoped — orgs *reference* it via
// `datasetOrganizations`, so one dataset can be shared across orgs on a
// deployment (upload once, update once → all referencing orgs move together).
// Data lives once per version, each version in its own DuckLake schema
// (`ducklake.<slug>_v<versionNumber>`).
export const datasets = pgTable(
  "datasets",
  {
    datasetId: uuid().defaultRandom().primaryKey(),
    // snake_case, unique per deployment. The per-version DuckLake schema name
    // derives as `${slug}_v${versionNumber}` (e.g. `nys_voter_file_v1`), so
    // slug is effectively immutable — a rename means renaming those schemas.
    slug: text().notNull(),
    name: text().notNull(),
    // Which curated importer decodes this dataset's sources (e.g.
    // "nys_voter_file"). Fixed at creation — every version is the same kind of
    // data — and resolved to a class through the data-side importer registry.
    importer: text().notNull(),
    // Pure identity: name + importer + slug, shared across all its versions.
    // Which version is *live* is the org's concern (`organizations.activeDatasetVersionId`),
    // not the dataset's — a version can be active for one org and not another.
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("datasets_slug").on(t.slug)],
);

export type DatasetVersionStatus = "importing" | "ready" | "failed";

// Properties derived once from a version's data at import time and cached here,
// so reads never recompute them over the (immutable) version's rows. Written by
// the data server's `finalize_version` alongside `manifest`. `rowCount` is the
// person count; `elections` backs the voting-history-detail filter's picker.
export type DerivedMetadata = {
  rowCount?: number;
  elections?: { value: string; label: string }[];
};

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
    // Derived-once-at-import cache (see `DerivedMetadata`); read like `manifest`.
    // Holds `rowCount` + `elections`.
    derivedMetadata: jsonb().$type<DerivedMetadata>(),
    sourceUri: text(),
    // Coarse import progress (step / total), shown as a % while `importing`.
    importStep: integer(),
    importTotalSteps: integer(),
    status: text().$type<DatasetVersionStatus>().notNull().default("importing"),
    // Why the import failed — null unless status is "failed". Written by the
    // import job alongside the status flip.
    error: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid().references(() => users.id),
    // Soft-hide from the Data list; versions are never deleted (published turfs
    // reference them).
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("dataset_versions_number").on(t.datasetId, t.versionNumber)],
);
