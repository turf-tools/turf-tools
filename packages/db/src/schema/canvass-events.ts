import { bigserial, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { turfs } from "./turfs";
import { users } from "./users";

// Append-only event log for canvass results. Every result change (survey
// response, unavailable outcome, note, empty mark) is an immutable append.
// "Current state" for an entity = latest event by sequence.
//
// Exactly one of (personId, doorId, buildingId) is set per event, identifying
// the target entity level.

// TODO - migrate from sequence as primaryKey to (turfId, sequence) as primary key
// Already matches access pattern
// Sequence will still be unique across turfs, but this will make it possible to partition / clean up later
export const canvassEvents = pgTable(
  "canvass_events",
  {
    sequence: bigserial({ mode: "number" }).primaryKey(),
    eventId: text(), // TODO - call this clientEventId
    turfId: uuid()
      .notNull()
      .references(() => turfs.turfId),
    userId: uuid()
      .notNull()
      .references(() => users.userId),
    personId: text(),
    doorId: uuid(),
    buildingId: uuid(),
    type: text().notNull(),
    payload: jsonb().notNull(),
    inputType: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("canvass_events_event_id").on(t.eventId)],
);

// Payload discriminated union — shared between server and native app.

export type CanvassEventPayload =
  | { kind: "survey"; surveyQuestionId: string; surveyResponseOptionId: string }
  | { kind: "outcome"; outcome: string }
  | { kind: "note"; text: string; canvassedAt: string }
  | { kind: "empty" };

export type CanvassEvent = typeof canvassEvents.$inferSelect;
