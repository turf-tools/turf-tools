import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { TurfData } from "./turfs";
import { turfs } from "./turfs";

// Per-turf payload — the buildings → doors → persons hierarchy a
// canvasser loads in the native app. Split out from `turfs` so the
// metadata table stays light for list queries; the heavy blob is
// fetched on demand via the dedicated RPC. One row per turf,
// generated at publish time and never modified afterward (turfs are
// forever snapshots).
//
// Cascade on turf delete — if the parent row is gone, the blob is
// orphaned data.
export const turfData = pgTable("turf_data", {
  turfId: uuid()
    .primaryKey()
    .references(() => turfs.turfId, { onDelete: "cascade" }),
  data: jsonb().$type<TurfData>().notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
