import { eq, type Db } from "@turf-tools/db";
import { datasetVersions, organizations } from "@turf-tools/db/schema";

// The dataset the org is currently working against — the active version's
// dataset (`organizations.active_dataset_version_id → dataset_versions.dataset_id`).
// Null when no version is active: the empty-workspace state, where the
// data-dependent lists (segments/campaigns/zones) show nothing and there's
// no dataset to stamp new rows with. Both the list handlers (scope to it) and
// the create handlers (stamp it) resolve the workspace through here.
export async function activeDatasetId(db: Db, organizationId: string): Promise<string | null> {
  const [row] = await db
    .select({ datasetId: datasetVersions.datasetId })
    .from(organizations)
    .innerJoin(
      datasetVersions,
      eq(datasetVersions.datasetVersionId, organizations.activeDatasetVersionId),
    )
    .where(eq(organizations.organizationId, organizationId))
    .limit(1);
  return row?.datasetId ?? null;
}
