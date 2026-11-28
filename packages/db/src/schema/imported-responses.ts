import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { app } from "./app";
import { organizations } from "./organizations";
import { questions, responseOptions } from "./questions";

// Survey answers imported from an external system (e.g. VAN). Separate from
// field canvass_events — no turf — but Canvass Response filters UNION these
// in. personId is the lake external_id. Grain: one row per selected option
// (multi-select = multiple rows). Dedup via (org, sourceType, sourceKey).
export const importedResponses = app.table(
  "imported_responses",
  {
    importedResponseId: uuid().defaultRandom().primaryKey(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.organizationId),
    personId: text().notNull(),
    questionId: uuid()
      .notNull()
      .references(() => questions.questionId),
    responseOptionId: uuid()
      .notNull()
      .references(() => responseOptions.responseOptionId),
    respondedAt: timestamp({ withTimezone: true }).notNull(),
    sourceType: text().notNull(),
    sourceKey: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("imported_responses_org_source_key").on(
      t.organizationId,
      t.sourceType,
      t.sourceKey,
    ),
  ],
);
