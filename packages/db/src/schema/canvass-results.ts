import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { surveyQuestions, surveyResponseOptions } from "./surveys";
import { turfs } from "./turfs";
import { users } from "./users";

export const canvassResultsPersons = pgTable("canvass_results_persons", {
  canvassResultPersonId: uuid().defaultRandom().primaryKey(),
  clientMutationId: text().unique(),
  userId: uuid()
    .notNull()
    .references(() => users.userId),
  voterId: text(),
  voterFileId: text(),
  voterFileVersion: integer(),
  doorId: uuid(),
  buildingId: uuid(),
  turfId: uuid()
    .notNull()
    .references(() => turfs.turfId),
  outcome: text(),
  inputType: text(),
  surveyQuestionId: uuid().references(() => surveyQuestions.surveyQuestionId),
  surveyResponseOptionId: uuid().references(() => surveyResponseOptions.surveyResponseOptionId),
  notes: text(),
  empty: boolean().default(false),
  canvassedAt: timestamp({ withTimezone: true }).notNull(),
});

export const canvassResultsDoors = pgTable("canvass_results_doors", {
  canvassResultDoorId: uuid().defaultRandom().primaryKey(),
  clientMutationId: text().unique(),
  doorId: uuid(),
  turfId: uuid()
    .notNull()
    .references(() => turfs.turfId),
  outcome: text(),
  createdBy: uuid()
    .notNull()
    .references(() => users.userId),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export const canvassResultsBuildings = pgTable("canvass_results_buildings", {
  canvassResultBuildingId: uuid().defaultRandom().primaryKey(),
  clientMutationId: text().unique(),
  buildingId: uuid(),
  turfId: uuid()
    .notNull()
    .references(() => turfs.turfId),
  outcome: text(),
  createdBy: uuid()
    .notNull()
    .references(() => users.userId),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
