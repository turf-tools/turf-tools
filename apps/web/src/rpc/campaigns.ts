import { and, asc, eq } from "@field-tools/db";
import { campaigns } from "@field-tools/db/schema";
import { z } from "zod";
import { pub } from "./context";

const campaignSelect = {
  campaignId: campaigns.campaignId,
  name: campaigns.name,
  startsAt: campaigns.startsAt,
  endsAt: campaigns.endsAt,
  createdAt: campaigns.createdAt,
};

// List campaigns in the current user's organization, oldest first.
export const list = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  const rows = await context.db
    .select(campaignSelect)
    .from(campaigns)
    .where(eq(campaigns.organizationId, context.user.organizationId))
    .orderBy(asc(campaigns.createdAt));
  return rows;
});

// Fetch one campaign by id, scoped to the user's organization.
export const getById = pub
  .input(z.object({ campaignId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const rows = await context.db
      .select(campaignSelect)
      .from(campaigns)
      .where(
        and(
          eq(campaigns.campaignId, input.campaignId),
          eq(campaigns.organizationId, context.user.organizationId),
        ),
      );
    return rows[0] ?? null;
  });
