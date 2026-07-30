import { jsonb, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./app";
import { type GeoJsonPolygon, turfs } from "./turfs";

// Per-turf payload — the buildings → doors → persons hierarchy a
// canvasser loads in the native app. Split out from `turfs` so the
// metadata table stays light for list queries; the heavy blob is
// fetched on demand via the dedicated RPC. One row per turf,
// generated at publish time and never modified afterward (turfs are
// forever snapshots).
//
// Cascade on turf delete — if the parent row is gone, the blob is
// orphaned data.
export const turfData = app.table("turf_data", {
  turfId: uuid()
    .primaryKey()
    .references(() => turfs.turfId, { onDelete: "cascade" }),
  data: jsonb().$type<TurfData>().notNull(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

// Type definitions for the JSON payload stored in `turf_data.data`.
// Mirrors the structure the canvasser app expects.

export type TurfDataAddress = {
  // Full canonical street address (e.g. "123 MAIN ST"). The data
  // pipeline produces this as `address_line_1` — house number and
  // street name are merged upstream, so consumers never need to
  // recompose them.
  street: string | null;
  unit?: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

export type VotingHistoryEntry = {
  year: number;
  type: string;
  date: string | null;
  method: string;
};

export type TurfDataPerson = {
  personId: string;
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  // Jr/Sr/III — disambiguates same-name voters at a door.
  nameSuffix: string | null;
  // Optional display fields the walk-list card shows. The publish payload omits
  // any the dataset doesn't provide (so `undefined` means "not in this dataset,"
  // vs `null` meaning "present but unknown") — the card hides absent ones.
  enrollment?: string | null;
  gender?: string | null;
  dateOfBirth?: string | null; // ISO 8601 YYYY-MM-DD
  votingHistory?: VotingHistoryEntry[];
};

export type TurfDataDoor = {
  doorId: string;
  unit: string | null;
  persons: TurfDataPerson[];
};

export type TurfDataBuilding = {
  buildingId: string;
  latitude: number | null;
  longitude: number | null;
  address: TurfDataAddress;
  doors: TurfDataDoor[];
};

export type TurfData = {
  turfId: string;
  // Mirrors `turfs.turfCode` — short, human-readable identifier
  // generated at publish time. Carried in the blob so consumers
  // that load only the data (offline cache, exports, sync
  // deltas) have a stable code without a join.
  turfCode: string;
  name: string;
  geometry: GeoJsonPolygon;
  buildings: TurfDataBuilding[];
};
