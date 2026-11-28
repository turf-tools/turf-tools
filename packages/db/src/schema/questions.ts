import { integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { app } from "./app";
import { organizations } from "./organizations";
import { users } from "./auth/users";

// A question is a named question with text and a response type.
// Standalone and org-level; referenced by script steps and reusable
// across scripts.
export const questions = app.table("questions", {
  questionId: uuid().defaultRandom().primaryKey(),
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

// One selectable answer for a question. Order is per-question.
export const responseOptions = app.table("response_options", {
  responseOptionId: uuid().defaultRandom().primaryKey(),
  questionId: uuid()
    .notNull()
    .references(() => questions.questionId),
  text: text().notNull(),
  order: integer().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.id),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  // Soft-delete: keep the row so responses/segment filters referencing this
  // option id stay resolvable; hidden from active pickers + the live script.
  archivedAt: timestamp({ withTimezone: true }),
});

// Maps an external survey system's question id onto an org question.
// `sourceType` is a free string (e.g. 'van'); not a schema column named for
// any one vendor. One link per (question, source); one owner per (org, source, id).
export const questionExternalIds = app.table(
  "question_external_ids",
  {
    questionExternalId: uuid().defaultRandom().primaryKey(),
    questionId: uuid()
      .notNull()
      .references(() => questions.questionId, { onDelete: "cascade" }),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.organizationId),
    sourceType: text().notNull(),
    externalId: text().notNull(),
  },
  (t) => [
    uniqueIndex("question_external_ids_org_source_ext").on(
      t.organizationId,
      t.sourceType,
      t.externalId,
    ),
    uniqueIndex("question_external_ids_question_source").on(t.questionId, t.sourceType),
  ],
);

// Maps an external survey system's response id onto a response option.
export const responseOptionExternalIds = app.table(
  "response_option_external_ids",
  {
    responseOptionExternalId: uuid().defaultRandom().primaryKey(),
    responseOptionId: uuid()
      .notNull()
      .references(() => responseOptions.responseOptionId, { onDelete: "cascade" }),
    questionId: uuid()
      .notNull()
      .references(() => questions.questionId, { onDelete: "cascade" }),
    sourceType: text().notNull(),
    externalId: text().notNull(),
  },
  (t) => [
    uniqueIndex("response_option_external_ids_question_source_ext").on(
      t.questionId,
      t.sourceType,
      t.externalId,
    ),
    uniqueIndex("response_option_external_ids_option_source").on(t.responseOptionId, t.sourceType),
  ],
);
