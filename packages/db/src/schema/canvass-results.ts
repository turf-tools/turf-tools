import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { surveyQuestions, surveyResponseOptions } from "./surveys";
import { turfs } from "./turfs";
import { users } from "./users";

export const canvassResultsPersons = pgTable(
  "canvass_results_persons",
  {
    canvassResultPersonId: uuid().defaultRandom().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.userId),
    voterId: text(),
    doorId: uuid(),
    buildingId: uuid(),
    turfId: uuid()
      .notNull()
      .references(() => turfs.turfId),
    outcome: text(),
    inputType: text(),
    surveyQuestionId: uuid().references(() => surveyQuestions.surveyQuestionId),
    surveyResponseOptionId: uuid().references(() => surveyResponseOptions.surveyResponseOptionId),
    empty: boolean().default(false),
    canvassedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("canvass_results_persons_turf_voter_user").on(t.turfId, t.voterId, t.userId)],
);

export const canvassResultsDoors = pgTable("canvass_results_doors", {
  canvassResultDoorId: uuid().defaultRandom().primaryKey(),
  doorId: uuid(),
  turfId: uuid()
    .notNull()
    .references(() => turfs.turfId),
  outcome: text(),
  userId: uuid()
    .notNull()
    .references(() => users.userId),
  canvassedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export const canvassResultsBuildings = pgTable("canvass_results_buildings", {
  canvassResultBuildingId: uuid().defaultRandom().primaryKey(),
  buildingId: uuid(),
  turfId: uuid()
    .notNull()
    .references(() => turfs.turfId),
  outcome: text(),
  userId: uuid()
    .notNull()
    .references(() => users.userId),
  canvassedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export const canvassNotes = pgTable(
  "canvass_notes",
  {
    canvassNoteId: uuid().defaultRandom().primaryKey(),
    turfId: uuid()
      .notNull()
      .references(() => turfs.turfId),
    userId: uuid()
      .notNull()
      .references(() => users.userId),
    personId: text(),
    doorId: uuid(),
    buildingId: uuid(),
    text: text().notNull(),
    canvassedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("canvass_notes_turf_user_time").on(t.turfId, t.userId, t.canvassedAt)],
);
