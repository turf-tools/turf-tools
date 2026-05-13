import {
  bigserial,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { turfs } from "./turfs";
import { users } from "./auth/users";

// Append-only event log for canvass results. Every result change (survey
// response, unavailable outcome, note, empty mark) is an immutable append.
// "Current state" for an entity = latest event by sequence.
//
// Exactly one of (personId, doorId, buildingId) is set per event, identifying
// the target entity level.
//
// Primary key is (turfId, sequence) rather than just sequence: sequence stays
// globally unique (bigserial), but the composite PK matches the actual access
// pattern (queries are always turf-scoped) and keeps the door open to
// partitioning by turfId later without a PK migration on populated data.
//
// `clientEventId` is the client-supplied UUID used for retry deduplication —
// it's NOT the row's primary id, hence the explicit `client` prefix.

export const canvassEvents = pgTable(
  "canvass_events",
  {
    sequence: bigserial({ mode: "number" }).notNull(),
    clientEventId: text(),
    turfId: uuid()
      .notNull()
      .references(() => turfs.turfId),
    // Nullable: events from the auth-less canvasser flow have no user; they
    // attribute via `createdByName` instead. Admin-attributed events set the FK.
    userId: uuid().references(() => users.id),
    createdByName: text(),
    personId: text(),
    doorId: uuid(),
    buildingId: uuid(),
    type: text().notNull(),
    payload: jsonb().notNull(),
    inputType: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.turfId, t.sequence] }),
    uniqueIndex("canvass_events_client_event_id").on(t.clientEventId),
  ],
);

// Payload discriminated union — shared between server and native app.

export type CanvassEventPayload =
  | { kind: "survey"; surveyQuestionId: string; surveyResponseOptionId: string }
  | { kind: "outcome"; outcome: string }
  | { kind: "note"; text: string; canvassedAt: string }
  | { kind: "empty" };

export type CanvassEvent = typeof canvassEvents.$inferSelect;
