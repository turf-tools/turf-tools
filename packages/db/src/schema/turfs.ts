import { jsonb, pgTable, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { campaigns } from "./campaigns";
import { scripts } from "./scripts";
import { universes } from "./universes";
import { users } from "./users";

export const turfs = pgTable("turfs", {
  turfId: uuid().defaultRandom().primaryKey(),
  campaignId: uuid()
    .notNull()
    .references(() => campaigns.campaignId),
  universeId: uuid()
    .notNull()
    .references(() => universes.universeId),
  scriptId: uuid()
    .notNull()
    .references(() => scripts.scriptId),
  name: text().notNull(),
  geometry: jsonb(),
  dataUrl: text(),
  doors: integer(),
  people: integer(),
  assignedTo: uuid().references(() => users.userId),
  createdBy: uuid()
    .notNull()
    .references(() => users.userId),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

// Schema for the turf data stored at `turfs.dataUrl`

export type GeoJsonPolygon = {
  type: "Polygon";
  coordinates: number[][][];
};

export type TurfDataAddress = {
  houseNumber: string | null;
  street: string | null;
  unit?: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

export type TurfDataPerson = {
  personId: string;
  firstName: string | null;
  lastName: string | null;
  party: string | null;
};

export type TurfDataDoor = {
  doorId: string;
  unit: string | null;
  people: TurfDataPerson[];
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
  name: string;
  voterFileId: string;
  voterFileVersion: number;
  geometry: GeoJsonPolygon;
  buildings: TurfDataBuilding[];
};
