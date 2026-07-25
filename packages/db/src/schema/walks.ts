import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { turfs } from "./turfs";
import { users } from "./auth/users";

// One row per outing: a canvasser taking a turf out once. Opened
// synchronously when the native app binds a turf (binding already requires
// connectivity and attribution, so every walk arrives complete), closed
// either implicitly — the same phone opening its next walk — or explicitly
// by a lead clearing a stray.
//
// A walk is an interval, not an event: active = `closedAt IS NULL`. Turfs
// can hold many active walks at once (pair canvassing); a rescan of the
// same turf by the same phone dedupes into the existing active walk
// instead of opening a new one.
//
// Attribution is the client-claimed identity, same as `canvass_events` —
// stored verbatim, no FK. `closedBy` is set only when a lead clears the
// walk from the web app; implicit closes leave it null.

export const walks = pgTable(
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
    closedBy: uuid().references(() => users.id),
  },
  (t) => [
    index("walks_turf_id").on(t.turfId),
    // Serves the implicit-close and rescan-dedup lookups, which only ever
    // target active walks.
    index("walks_active_phone")
      .on(t.canvasserPhone)
      .where(sql`${t.closedAt} IS NULL`),
  ],
);

export type Walk = typeof walks.$inferSelect;
