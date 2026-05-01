import { integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { surveyQuestions } from "./surveys";
import { users } from "./users";

// A script is a sequence of survey questions presented to canvassers at
// the door. Standalone and reusable across campaigns; each campaign
// references one script.
export const scripts = pgTable("scripts", {
  scriptId: uuid().defaultRandom().primaryKey(),
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
