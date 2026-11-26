// Ensure a hidden "VAN History" campaign + superseded turf so imported
// canvass_events have a turfId. Filters join events → turfs → campaigns → org
// and do not require the turf to be active.

import { and, eq, type Db } from "@turf-tools/db";
import {
  campaigns,
  datasetVersions,
  organizations,
  scripts,
  segments,
  turfs,
  type GeoJsonPolygon,
} from "@turf-tools/db/schema";
import { activeDatasetId } from "~/rpc/web/active-dataset";

const VAN_HISTORY_NAME = "VAN History";

const STUB_GEOMETRY: GeoJsonPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [0, 0.0001],
      [0.0001, 0.0001],
      [0.0001, 0],
      [0, 0],
    ],
  ],
};

function turfCodeFor(orgSlug: string): string {
  // Global unique; org slug is already URL/SQL-safe.
  return `VANHIST-${orgSlug}`;
}

export async function ensureVanHistoryTurf(
  db: Db,
  opts: { organizationId: string; orgSlug: string; userId: string },
): Promise<{ turfId: string; datasetVersionId: string }> {
  const code = turfCodeFor(opts.orgSlug);
  const existing = await db
    .select({
      turfId: turfs.turfId,
      datasetVersionId: turfs.datasetVersionId,
    })
    .from(turfs)
    .where(eq(turfs.turfCode, code))
    .limit(1);
  if (existing[0]) {
    return {
      turfId: existing[0].turfId,
      datasetVersionId: existing[0].datasetVersionId,
    };
  }

  const datasetId = await activeDatasetId(db, opts.organizationId);
  if (!datasetId) {
    throw new Error("Activate a dataset before importing VAN responses.");
  }

  const [org] = await db
    .select({ activeDatasetVersionId: organizations.activeDatasetVersionId })
    .from(organizations)
    .where(eq(organizations.organizationId, opts.organizationId))
    .limit(1);
  const datasetVersionId = org?.activeDatasetVersionId;
  if (!datasetVersionId) {
    throw new Error("Activate a dataset before importing VAN responses.");
  }

  // Confirm the version still belongs to the active dataset (defensive).
  const [version] = await db
    .select({ datasetVersionId: datasetVersions.datasetVersionId })
    .from(datasetVersions)
    .where(
      and(
        eq(datasetVersions.datasetVersionId, datasetVersionId),
        eq(datasetVersions.datasetId, datasetId),
      ),
    )
    .limit(1);
  if (!version) {
    throw new Error("Activate a dataset before importing VAN responses.");
  }

  return db.transaction(async (tx) => {
    const [script] = await tx
      .insert(scripts)
      .values({
        organizationId: opts.organizationId,
        name: VAN_HISTORY_NAME,
        createdBy: opts.userId,
        archivedAt: new Date(),
      })
      .returning({ scriptId: scripts.scriptId });

    const [segment] = await tx
      .insert(segments)
      .values({
        organizationId: opts.organizationId,
        name: VAN_HISTORY_NAME,
        criteria: { steps: [] },
        datasetId,
        createdBy: opts.userId,
        archivedAt: new Date(),
      })
      .returning({ segmentId: segments.segmentId });

    const [campaign] = await tx
      .insert(campaigns)
      .values({
        organizationId: opts.organizationId,
        datasetId,
        name: VAN_HISTORY_NAME,
        segmentId: segment!.segmentId,
        scriptId: script!.scriptId,
        createdBy: opts.userId,
        archivedAt: new Date(),
      })
      .returning({ campaignId: campaigns.campaignId });

    const [turf] = await tx
      .insert(turfs)
      .values({
        campaignId: campaign!.campaignId,
        segmentId: segment!.segmentId,
        datasetVersionId,
        scriptId: script!.scriptId,
        name: VAN_HISTORY_NAME,
        turfCode: code,
        criteria: { steps: [] },
        status: "superseded",
        geometry: STUB_GEOMETRY,
        buildingCoords: [],
        doorCount: 0,
        personCount: 0,
        createdBy: opts.userId,
      })
      .returning({ turfId: turfs.turfId });

    return { turfId: turf!.turfId, datasetVersionId };
  });
}
