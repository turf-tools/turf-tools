import { integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { app } from "./app";
import { organizations } from "./organizations";
import { users } from "./auth/users";

// A question is a named question with text and a response type.
// Standalone and org-level; referenced by script steps and reusable
// across scripts.
export const questions = app.table(
  "questions",
  {
    questionId: uuid().defaultRandom().primaryKey(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.organizationId),
    name: text().notNull(),
    responseType: text().notNull(),
    text: text().notNull(),
    // VAN SurveyQuestionId from a survey-results export. Null when the
    // question was authored in-app rather than imported.
    vanId: text(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("questions_org_van_id").on(t.organizationId, t.vanId)],
);

// One selectable answer for a question. Order is per-question.
export const responseOptions = app.table(
  "response_options",
  {
    responseOptionId: uuid().defaultRandom().primaryKey(),
    questionId: uuid()
      .notNull()
      .references(() => questions.questionId),
    text: text().notNull(),
    order: integer().notNull(),
    // VAN SurveyResponseId. Null when the option was authored in-app.
    vanId: text(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    // Soft-delete: keep the row so responses/segment filters referencing this
    // option id stay resolvable; hidden from active pickers + the live script.
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("response_options_question_van_id").on(t.questionId, t.vanId)],
);
