import { and, eq, inArray, isNull, ne } from "@turf-tools/db";
import { campaigns, turfs, walks } from "@turf-tools/db/schema";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { publish } from "~/lib/server/live";
import { nativeMut as mut } from "../context";

// Record that a canvasser took a turf out. Called by the native app at
// bind time — the moment it has both the turf and the attested identity.
// Capability-based like the rest of the native tier: possessing the
// turfId is the access.
//
// Two side effects keyed on the phone (skipped when the client sends
// none):
//   - rescan dedup: an active walk for the same (turf, phone) is
//     returned as-is instead of opening a duplicate
//   - implicit close: active walks for the same phone on *other* turfs
//     close, mirroring the native app's one-active-turf-per-device
//     invariant. Scoped to the turf's organization so a phone-number
//     collision across orgs can't close a stranger's walk.
export const open = mut
  .input(
    z.object({
      turfId: z.string().uuid(),
      canvasserName: z.string().min(1),
      canvasserPhone: z.string().optional(),
    }),
  )
  .handler(async ({ context, input }) => {
    const turfRow = (
      await context.db
        .select({ organizationId: campaigns.organizationId })
        .from(turfs)
        .innerJoin(campaigns, eq(turfs.campaignId, campaigns.campaignId))
        .where(eq(turfs.turfId, input.turfId))
    )[0];
    if (!turfRow) throw new ORPCError("NOT_FOUND");

    const phone = input.canvasserPhone;
    if (phone) {
      const existing = (
        await context.db
          .select({ walkId: walks.walkId })
          .from(walks)
          .where(
            and(
              eq(walks.turfId, input.turfId),
              eq(walks.canvasserPhone, phone),
              isNull(walks.closedAt),
            ),
          )
      )[0];
      if (existing) return { walkId: existing.walkId };

      const orgTurfIds = context.db
        .select({ turfId: turfs.turfId })
        .from(turfs)
        .innerJoin(campaigns, eq(turfs.campaignId, campaigns.campaignId))
        .where(eq(campaigns.organizationId, turfRow.organizationId));
      await context.db
        .update(walks)
        .set({ closedAt: new Date() })
        .where(
          and(
            eq(walks.canvasserPhone, phone),
            isNull(walks.closedAt),
            ne(walks.turfId, input.turfId),
            inArray(walks.turfId, orgTurfIds),
          ),
        );
    }

    const inserted = await context.db
      .insert(walks)
      .values({
        turfId: input.turfId,
        canvasserName: input.canvasserName,
        canvasserPhone: phone,
      })
      .returning({ walkId: walks.walkId });
    publish(turfRow.organizationId);
    return { walkId: inserted[0]!.walkId };
  });

// Best-effort close from the native app's explicit unbind ("Download new
// turf"). Keyed on (turfId, phone) since the client doesn't track
// walkIds. The client fires and forgets: an offline unbind just leaves
// the walk to the fallbacks (implicit close on next open, lead clear).
export const close = mut
  .input(
    z.object({
      turfId: z.string().uuid(),
      canvasserPhone: z.string().min(1),
    }),
  )
  .handler(async ({ context, input }) => {
    const closed = await context.db
      .update(walks)
      .set({ closedAt: new Date() })
      .where(
        and(
          eq(walks.turfId, input.turfId),
          eq(walks.canvasserPhone, input.canvasserPhone),
          isNull(walks.closedAt),
        ),
      )
      .returning({ walkId: walks.walkId });
    if (closed.length > 0) {
      const org = (
        await context.db
          .select({ organizationId: campaigns.organizationId })
          .from(turfs)
          .innerJoin(campaigns, eq(turfs.campaignId, campaigns.campaignId))
          .where(eq(turfs.turfId, input.turfId))
      )[0];
      if (org) publish(org.organizationId);
    }
    return { ok: true };
  });
