import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./app";
import { sql } from "drizzle-orm";
import { turfs } from "./turfs";

// One row per outing: a canvasser taking a turf out once. Opened
// synchronously when the native app binds a turf (binding already requires
// connectivity and attribution, so every walk arrives complete), closed
// either explicitly — "Download new turf", best-effort when online — or
// implicitly, when the same phone opens its next walk.
//
// A walk is an interval, not an event: active = `closedAt IS NULL`. Turfs
// can hold many active walks at once (pair canvassing); a rescan of the
// same turf by the same phone dedupes into the existing active walk only
// while it's recent enough to be the same outing — older ones close and
// a new walk opens. Walks that are never closed decay out of the "live"
// display client-side rather than being mutated.
//
// Attribution is the client-claimed identity, same as `canvass_events` —
// stored verbatim, no FK.

export const walks = app.table(
  "walks",
  {
    walkId: uuid().defaultRandom().primaryKey(),
    turfId: uuid()
      .notNull()
      .references(() => turfs.turfId),
    canvasserName: text().notNull(),
    canvasserPhone: text(),
    openedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp({ withTimezone: true }),
    // Lead-declared "this sign-out doesn't count" (test open, wrong-zone
    // scan). Only ever stamped on event-less walks; the board re-checks at
    // read time, so a walk whose events arrive late shows despite it.
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("walks_turf_id").on(t.turfId),
    // Serves the phone-keyed lookups (rescan dedup, implicit close on
    // next open, explicit close on unbind), which only ever target
    // active walks.
    index("walks_active_phone")
      .on(t.canvasserPhone)
      .where(sql`${t.closedAt} IS NULL`),
  ],
);

export type Walk = typeof walks.$inferSelect;
