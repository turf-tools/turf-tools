import { integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./app";
import { organizations } from "./organizations";
import { questions, responseOptions } from "./questions";
import { users } from "./auth/users";

// A script is an ordered sequence of steps presented to canvassers at the
// door. Standalone and reusable across campaigns; each campaign references
// one script.
export const scripts = app.table("scripts", {
  scriptId: uuid().defaultRandom().primaryKey(),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.organizationId),
  name: text().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.id),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  // Soft retirement — archived scripts leave the rail and pickers but
  // stay resolvable for the campaigns and turfs that reference them.
  archivedAt: timestamp({ withTimezone: true }),
});

// A step is either stepType='question' (referencing a reusable
// question) or stepType='text' (carrying its copy inline). Type/payload
// consistency is enforced at the RPC layer.
export const scriptSteps = app.table("script_steps", {
  scriptStepId: uuid().defaultRandom().primaryKey(),
  scriptId: uuid()
    .notNull()
    .references(() => scripts.scriptId, { onDelete: "cascade" }),
  order: integer().notNull(),
  stepType: text().notNull(),
  questionId: uuid().references(() => questions.questionId),
  text: text(),
  // Conditional visibility: show this step only while the referenced option is
  // selected. The option must belong to a single-select question on an earlier
  // step of the same script (RPC-enforced), so visibility is a single forward
  // pass and cycles are impossible.
  showIfOptionId: uuid().references(() => responseOptions.responseOptionId),
});
