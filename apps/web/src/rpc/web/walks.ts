import { and, asc, eq } from "@turf-tools/db";
import { campaigns, turfScans, turfs, walks } from "@turf-tools/db/schema";
import { z } from "zod";
import { webPub as pub } from "../context";

// Walks plus the transient scan signals for the org's turfs, optionally
// campaign-filtered — one payload because the board derives its state
// from both and polls them together. Flat walks (clients group by
// turfId): a campaign's whole walk history is small — hundreds of rows
// at most.
export const listForOrg = pub
  .input(z.object({ campaignId: z.string().uuid().optional() }).optional())
  .handler(async ({ context, input }) => {
    const orgFilter = eq(campaigns.organizationId, context.organizationId);
    const where = input?.campaignId
      ? and(orgFilter, eq(turfs.campaignId, input.campaignId))
      : orgFilter;
    const walkRows = await context.db
      .select({
        walkId: walks.walkId,
        turfId: walks.turfId,
        canvasserName: walks.canvasserName,
        openedAt: walks.openedAt,
        closedAt: walks.closedAt,
        closedBy: walks.closedBy,
      })
      .from(walks)
      .innerJoin(turfs, eq(walks.turfId, turfs.turfId))
      .innerJoin(campaigns, eq(turfs.campaignId, campaigns.campaignId))
      .where(where)
      .orderBy(asc(walks.openedAt));
    const scanRows = await context.db
      .select({ turfId: turfScans.turfId, scannedAt: turfScans.scannedAt })
      .from(turfScans)
      .innerJoin(turfs, eq(turfScans.turfId, turfs.turfId))
      .innerJoin(campaigns, eq(turfs.campaignId, campaigns.campaignId))
      .where(where);
    return { walks: walkRows, scans: scanRows };
  });
