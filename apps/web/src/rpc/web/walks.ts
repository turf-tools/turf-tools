import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNull } from "@turf-tools/db";
import { campaigns, turfs, walks } from "@turf-tools/db/schema";
import { z } from "zod";
import { webMut as mut, webPub as pub } from "../context";

// All walks on the org's turfs, optionally campaign-filtered. Returned
// flat (clients group by turfId): a campaign's whole walk history is small
// — hundreds of rows at most — and one flat query keeps the polling
// payload cheap.
export const listForOrg = pub
  .input(z.object({ campaignId: z.string().uuid().optional() }).optional())
  .handler(async ({ context, input }) => {
    const orgFilter = eq(campaigns.organizationId, context.organizationId);
    const where = input?.campaignId
      ? and(orgFilter, eq(turfs.campaignId, input.campaignId))
      : orgFilter;
    return context.db
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
  });

// Close a stray active walk (phone died, canvasser went home). `closedBy`
// records the clearing user — implicit closes leave it null, so history
// stays honest about who ended a walk.
export const clear = mut
  .input(z.object({ walkId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const updated = await context.db
      .update(walks)
      .set({ closedAt: new Date(), closedBy: context.user.id })
      .where(
        and(
          eq(walks.walkId, input.walkId),
          isNull(walks.closedAt),
          // Org scoping: the walk's turf must belong to the caller's org.
          inArray(
            walks.turfId,
            context.db
              .select({ turfId: turfs.turfId })
              .from(turfs)
              .innerJoin(campaigns, eq(turfs.campaignId, campaigns.campaignId))
              .where(eq(campaigns.organizationId, context.organizationId)),
          ),
        ),
      )
      .returning({ walkId: walks.walkId });
    if (updated.length === 0) throw new ORPCError("NOT_FOUND");
    return { ok: true };
  });
