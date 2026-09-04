import { and, asc, eq, exists, inArray, isNull, notExists, or, sql, type Db } from "@turf-tools/db";
import { campaigns, canvassEvents, turfs, walks } from "@turf-tools/db/schema";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { scansForOrg } from "~/lib/server/scans";
import { publish } from "~/lib/server/live";
import { activeDatasetId } from "./active-dataset";
import { webMut as mut, webPub as pub } from "../context";

// Events attributed to this walk. Correlated on turf_id too so the probe
// rides the events PK instead of needing a walk_id index (which would tax
// the append path); a turf's event count is small.
const walkEvents = (db: Db) =>
  db
    .select({ one: sql`1` })
    .from(canvassEvents)
    .where(and(eq(canvassEvents.turfId, walks.turfId), eq(canvassEvents.walkId, walks.walkId)));

// Walks plus the transient scan signals for the org's turfs, optionally
// campaign-filtered — one payload because the board derives its state
// from both and polls them together. Active-dataset scoped like
// turfs.listForOrg, so the board's walks always match its rows. Flat walks
// (clients group by turfId): a campaign's whole walk history is small —
// hundreds of rows at most.
//
// Archived walks are hidden unless events exist for them: an archive
// claims a sign-out produced nothing, and activity disproves it (the
// offline tail, or a race with the archive itself). Enforced here at
// read time so the event append path stays untouched.
export const listForOrg = pub
  .input(z.object({ campaignId: z.string().uuid().optional() }).optional())
  .handler(async ({ context, input }) => {
    const datasetId = await activeDatasetId(context.db, context.organizationId);
    if (!datasetId) return { walks: [], scans: [] };
    const scope = and(
      eq(campaigns.organizationId, context.organizationId),
      eq(campaigns.datasetId, datasetId),
      or(isNull(walks.archivedAt), exists(walkEvents(context.db))),
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

// Remove a mistaken sign-out (test open, wrong-zone scan) from the
// board. Only event-less walks can go — the guard lives inside the
// UPDATE so it's atomic with the stamp — and listForOrg re-checks on
// read, so a walk that gains events afterward comes back on its own.
// Also closes a still-open walk so it stops matching the active-walk
// lookups.
export const archive = mut
  .input(z.object({ walkId: z.string().uuid() }))
  .handler(async ({ context, input }) => {
    const orgTurfIds = context.db
      .select({ turfId: turfs.turfId })
      .from(turfs)
      .innerJoin(campaigns, eq(turfs.campaignId, campaigns.campaignId))
      .where(eq(campaigns.organizationId, context.organizationId));
    const archived = await context.db
      .update(walks)
      .set({
        archivedAt: new Date(),
        closedAt: sql`coalesce(${walks.closedAt}, now())`,
      })
      .where(
        and(
          eq(walks.walkId, input.walkId),
          inArray(walks.turfId, orgTurfIds),
          notExists(walkEvents(context.db)),
        ),
      )
      .returning({ walkId: walks.walkId });
    if (archived.length === 0) {
      const owned = await context.db
        .select({ walkId: walks.walkId })
        .from(walks)
        .where(and(eq(walks.walkId, input.walkId), inArray(walks.turfId, orgTurfIds)));
      if (owned.length === 0) throw new ORPCError("NOT_FOUND", { message: "Walk not found" });
      throw new ORPCError("CONFLICT", {
        message: "This walk has recorded activity, so it can't be removed.",
      });
    }
    publish(context.organizationId);
    return { ok: true };
  });
