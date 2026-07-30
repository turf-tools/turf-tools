import { integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
