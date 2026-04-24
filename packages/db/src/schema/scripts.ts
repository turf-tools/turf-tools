import { integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { campaigns } from "./campaigns";
import { surveyQuestions } from "./surveys";
import { users } from "./users";

export const scripts = pgTable("scripts", {
  scriptId: uuid().defaultRandom().primaryKey(),
  campaignId: uuid()
    .notNull()
    .references(() => campaigns.campaignId),
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
