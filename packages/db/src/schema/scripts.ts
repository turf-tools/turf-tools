import { integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { surveyQuestions } from "./surveys";
import { tracks } from "./tracks";
import { users } from "./users";

export const scripts = pgTable("scripts", {
  scriptId: uuid().defaultRandom().primaryKey(),
  trackId: uuid()
    .notNull()
    .references(() => tracks.trackId),
  name: text().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.userId),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export const scriptQuestions = pgTable(
  "script_questions",
  {
    scriptId: uuid()
      .notNull()
      .references(() => scripts.scriptId),
    surveyQuestionId: uuid()
      .notNull()
      .references(() => surveyQuestions.surveyQuestionId),
    order: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.scriptId, t.surveyQuestionId] })],
);
