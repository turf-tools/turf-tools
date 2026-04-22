import { jsonb, pgTable, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { lists } from "./lists";
import { scripts } from "./scripts";
import { tracks } from "./tracks";
import { users } from "./users";

export const turfs = pgTable("turfs", {
  turfId: uuid().defaultRandom().primaryKey(),
  trackId: uuid()
    .notNull()
    .references(() => tracks.trackId),
  listId: uuid()
    .notNull()
    .references(() => lists.listId),
  scriptId: uuid()
    .notNull()
    .references(() => scripts.scriptId),
  name: text().notNull(),
  listCode: text().unique(),
  geometry: jsonb(),
  dataUrl: text(),
  doorCount: integer(),
  personCount: integer(),
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
  age: number | null;
  gender: string | null;
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
  name: string;
  voterFileId: string;
  voterFileVersion: number;
  geometry: GeoJsonPolygon;
  buildings: TurfDataBuilding[];
};
