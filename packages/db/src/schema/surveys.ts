import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./auth/users";

// A survey question is a named question with text and a
// response type.
export const surveyQuestions = pgTable("survey_questions", {
  surveyQuestionId: uuid().defaultRandom().primaryKey(),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.organizationId),
  name: text().notNull(),
  responseType: text().notNull(),
  text: text().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.id),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  archivedAt: timestamp({ withTimezone: true }),
});

// One selectable answer for a survey question. Order is per-question.
export const surveyResponseOptions = pgTable("survey_response_options", {
  surveyResponseOptionId: uuid().defaultRandom().primaryKey(),
  surveyQuestionId: uuid()
    .notNull()
    .references(() => surveyQuestions.surveyQuestionId),
  text: text().notNull(),
  order: integer().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.id),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
