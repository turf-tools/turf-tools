import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
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
export const turfData = pgTable("turf_data", {
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
  // Canonical voter-file scalars. Top-level fields so storage is shredded
  // (column pruning + Bloom filters server-side) and the wire shape mirrors
  // the canonical Person schema.
  enrollment: string | null;
  gender: string | null;
  dateOfBirth: string | null; // ISO 8601 YYYY-MM-DD
  registrationDate: string | null; // ISO 8601
  registrationStatus: string | null; // active|inactive|federal_only|preregistered|unknown
  lastVotedDate: string | null; // ISO 8601
  countyCode: string | null;
  precinct: string | null; // NYC: "AA-EEE"
  assemblyDistrict: string | null; // state lower chamber
  senateDistrict: string | null; // state senate
  congressionalDistrict: string | null;
  votingHistory: VotingHistoryEntry[];
  // Forward-compat slot for genuinely state-specific extras. Empty for NYS.
  otherProperties: Record<string, string | null>;
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
