import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { turfs } from "./turfs";

// Transient handoff signal: every successful code resolution (QR scan or
// typed code, via the native getByCode) upserts the turf's last-scan
// time. This is what lets the lead's board flip to "pending" the moment
// a canvasser commits to opening a turf — before attestation and the
// walk land. One row per turf, latest wins; history is the walks table's
// job, and a scan that never converts simply ages out of the UI.
export const turfScans = pgTable("turf_scans", {
  turfId: uuid()
    .primaryKey()
    .references(() => turfs.turfId),
  scannedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
