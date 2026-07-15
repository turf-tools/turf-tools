import { eq } from "@field-tools/db";
import { datasetOrganizations, datasets, datasetVersions } from "@field-tools/db/schema";
import { z } from "zod";
import type { Manifest } from "~/lib/manifest";
import { webPub as pub } from "../context";

// The org's active dataset version manifest — the field catalog the segment and
// zone editors render from. Resolved org → dataset_organizations → dataset →
// active version. Immutable per version, so the client caches it hard. Returns
// null when the org has no active dataset (empty state, pre-import).
export const manifest = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  const rows = await context.db
    .select({
      manifest: datasetVersions.manifest,
      versionId: datasetVersions.datasetVersionId,
    })
    .from(datasetOrganizations)
    .innerJoin(datasets, eq(datasets.datasetId, datasetOrganizations.datasetId))
    .innerJoin(datasetVersions, eq(datasetVersions.datasetVersionId, datasets.activeVersionId))
    .where(eq(datasetOrganizations.organizationId, context.organizationId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { manifest: row.manifest as Manifest, versionId: row.versionId };
});
