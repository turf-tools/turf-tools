import { integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { app } from "./app";
import { users } from "./auth/users";
import { datasets } from "./datasets";

// Custom-field types — scalar values, latest-upload-wins per person. Each
// maps 1:1 onto an existing filter kind (number-range / date-range / text /
// text-multi / enum). Membership lists are a one-column upload with a constant
// value (e.g. Employer → amazon), not a dedicated type.
// `text_multi` ("Code") matches whole values against a typed-in list, so "3"
// can't match "13"; `text` is a substring search and `enum` needs a picker
// small enough to enumerate.
export type CustomFieldType = "number" | "date" | "text" | "text_multi" | "enum";

// A custom field — a user-appended, dataset-scoped, typed column that floats
// across dataset versions. One row per field; values live in the lake's
// long-format `<slug>_custom_fields` table.
// Criteria reference `customFieldId` (never the label), so rename is a
// one-row UPDATE with no lake or saved-segment fallout.
export const customFields = app.table(
  "custom_fields",
  {
    customFieldId: uuid().defaultRandom().primaryKey(),
    datasetId: uuid()
      .notNull()
      .references(() => datasets.datasetId),
    label: text().notNull(),
    fieldType: text().$type<CustomFieldType>().notNull(),
    // Enum option set, derived from distinct values at ingest.
    values: text().array(),
    // Cached coverage (people with a value), synced by the only two value
    // writers (append ingest, clear); can't drift otherwise.
    personCount: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    // Soft-hide from the card / picker — display only, values untouched.
    // Re-appending the label revives (ingest nulls this).
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("custom_fields_dataset_label").on(t.datasetId, t.label)],
);

// Provenance for one append — inserted after the synchronous ingest succeeds
// (failed appends write nothing). The field dialog renders the latest upload's
// counts; lake values carry `upload_id` so every value traces back here.
export const customFieldUploads = app.table("custom_field_uploads", {
  customFieldUploadId: uuid().defaultRandom().primaryKey(),
  datasetId: uuid()
    .notNull()
    .references(() => datasets.datasetId),
  filename: text(),
  // Id (never the label — labels are display-only and renameable) of the
  // field this append wrote. One upload touches exactly one field.
  customFieldId: uuid()
    .notNull()
    .references(() => customFields.customFieldId),
  rowCount: integer(),
  // Rows with an id but no value — ignored entirely (prior values survive);
  // surfaced in the Append dialog so sparse files don't silently shrink.
  skippedCount: integer(),
  matchedCount: integer(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid().references(() => users.id),
});
