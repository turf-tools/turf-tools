import { sql } from "drizzle-orm";
import { check, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./app";
import { datasetVersions } from "./datasets";

// Slugs that are already top-level path segments on a deployment — the web
// app's static routes (apps/web/src/routes) plus `t`, which every printed turf
// QR encodes as `/t/<code>`. Static routes match before `$orgSlug`, so an org
// with one of these slugs would be unreachable. Extend when adding a route.
export const RESERVED_ORG_SLUGS = ["api", "auth", "login", "t"] as const;

export const organizations = app.table(
  "organizations",
  {
    organizationId: uuid().defaultRandom().primaryKey(),
    // URL/SQL-safe identifier — appears in page URLs (/<slug>/...), API
    // paths (/api/web/<slug>/...), and DuckLake schema names
    // (ducklake.<slug>.*). The CHECK below enforces URL/SQL safety at
    // the only layer nothing can bypass.
    slug: text().notNull().unique(),
    name: text().notNull(),
    // The dataset version this org is currently working against — the single
    // "active" pointer, set by "Make active". Null until the first import is
    // activated. It names both the current dataset and its live version at once.
    // Segments, campaigns, and zones resolve through it; published turfs ignore
    // it (each records the version it was published against).
    activeDatasetVersionId: uuid().references(() => datasetVersions.datasetVersionId),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Lowercase + digits + internal hyphens, start/end alphanumeric.
    // Rejects spaces, uppercase, leading/trailing/double hyphens.
    check("slug_format", sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'`),
    check(
      "slug_reserved",
      sql`${t.slug} <> ALL (ARRAY[${sql.raw(RESERVED_ORG_SLUGS.map((s) => `'${s}'`).join(", "))}])`,
    ),
  ],
);
