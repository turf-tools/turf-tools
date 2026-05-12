import { eq } from "@field-tools/db";
import { organizations } from "@field-tools/db/schema";
import { z } from "zod";
import { adminPub as pub } from "../context";

// Current organization for the logged-in user. Used by the breadcrumb.
export const getCurrent = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  const rows = await context.db
    .select({
      organizationId: organizations.organizationId,
      name: organizations.name,
    })
    .from(organizations)
    .where(eq(organizations.organizationId, context.organizationId));
  return rows[0] ?? null;
});
