import { and, asc, eq } from "@field-tools/db";
import { campaigns, segments } from "@field-tools/db/schema";
import { z } from "zod";
import { pub } from "./context";

const segmentSelect = {
  segmentId: segments.segmentId,
  campaignId: segments.campaignId,
  campaignName: campaigns.name,
  name: segments.name,
  doorCount: segments.doorCount,
  personCount: segments.personCount,
  voterFileId: segments.voterFileId,
  voterFileVersion: segments.voterFileVersion,
  createdAt: segments.createdAt,
};

// List segments in the current user's organization, optionally filtered to a
// specific campaign. Oldest first. "list" here is the HTTP verb, not the entity.
export const list = pub
  .input(z.object({ campaignId: z.string().uuid().optional() }).optional())
  .handler(async ({ context, input }) => {
    const orgFilter = eq(segments.organizationId, context.user.organizationId);
    const where = input?.campaignId
      ? and(orgFilter, eq(segments.campaignId, input.campaignId))
      : orgFilter;
    const rows = await context.db
      .select(segmentSelect)
      .from(segments)
      .innerJoin(campaigns, eq(segments.campaignId, campaigns.campaignId))
      .where(where)
      .orderBy(asc(segments.createdAt));
    return rows;
  });

// Fetch one segment by id, scoped to the user's organization.
export const getById = pub
  .input(z.object({ segmentId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(segmentSelect)
      .from(segments)
      .innerJoin(campaigns, eq(segments.campaignId, campaigns.campaignId))
      .where(
        and(
          eq(segments.segmentId, input.segmentId),
          eq(segments.organizationId, context.user.organizationId),
        ),
      );
    return rows[0] ?? null;
  });
