import { and, asc, eq } from "@turf-tools/db";
import { campaigns, turfs, walks } from "@turf-tools/db/schema";
import { z } from "zod";
import { scansForOrg } from "~/lib/server/scans";
import { activeDatasetId } from "./active-dataset";
import { webPub as pub } from "../context";

// Walks plus the transient scan signals for the org's turfs, optionally
// campaign-filtered — one payload because the board derives its state
// from both and polls them together. Active-dataset scoped like
// turfs.listForOrg, so the board's walks always match its rows. Flat walks
// (clients group by turfId): a campaign's whole walk history is small —
// hundreds of rows at most.
export const listForOrg = pub
  .input(z.object({ campaignId: z.string().uuid().optional() }).optional())
  .handler(async ({ context, input }) => {
    const datasetId = await activeDatasetId(context.db, context.organizationId);
    if (!datasetId) return { walks: [], scans: [] };
    const scope = and(
      eq(campaigns.organizationId, context.organizationId),
      eq(campaigns.datasetId, datasetId),
    );
    const where = input?.campaignId ? and(scope, eq(turfs.campaignId, input.campaignId)) : scope;
    const walkRows = await context.db
      .select({
        walkId: walks.walkId,
        turfId: walks.turfId,
        canvasserName: walks.canvasserName,
        canvasserPhone: walks.canvasserPhone,
        openedAt: walks.openedAt,
        closedAt: walks.closedAt,
      })
      .from(walks)
      .innerJoin(turfs, eq(walks.turfId, turfs.turfId))
      .innerJoin(campaigns, eq(turfs.campaignId, campaigns.campaignId))
      .where(where)
      .orderBy(asc(walks.openedAt));
    const scans = scansForOrg(context.organizationId, input?.campaignId);
    return { walks: walkRows, scans };
  });
