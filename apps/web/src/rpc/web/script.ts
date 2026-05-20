import { asc, eq } from "@field-tools/db";
import { scripts } from "@field-tools/db/schema";
import { z } from "zod";
import { webPub as pub } from "../context";

// List scripts in the current user's organization, oldest first. Used
// by the campaign editor's script dropdown.
export const list = pub.input(z.object({}).optional()).handler(async ({ context }) => {
  const rows = await context.db
    .select({
      scriptId: scripts.scriptId,
      name: scripts.name,
      createdAt: scripts.createdAt,
    })
    .from(scripts)
    .where(eq(scripts.organizationId, context.organizationId))
    .orderBy(asc(scripts.createdAt));
  return rows;
});
