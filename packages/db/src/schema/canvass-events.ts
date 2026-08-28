import {
  bigserial,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app } from "./app";
import { turfs } from "./turfs";
import { walks } from "./walks";

// Append-only event log for canvass results. Two kinds:
//   - "result": the complete current disposition of an entity (outcome +
//     responses). It's a full snapshot, not a delta — current state
//     is simply the latest result for the entity.
//   - "note": freeform text, append-only (never superseded).
//
// Exactly one of (personId, doorId, buildingId) is set per event.
//
// PK is (turfId, sequence) rather than just sequence: sequence stays globally
// unique (bigserial), but the composite PK matches the turf-scoped access
// pattern and leaves room to partition by turfId later.
//
// clientEventId is the client-supplied UUID for retry dedup.
//
// canvasserName and cavasserPhone are stamped by the client.
// Any future verification service can join on phone.
//
// walkId is the sign-out the event happened under, stamped by the client
// at bind time. Null from pre-stamp clients — imputable from walks by
// (turf, phone, open-interval).
//
// createdAt is CLIENT time (when it happened in the field); receivedAt is
// server time (when the server ingested it). The canonical ordering key is
// sequence. canvasserId is the universal canvasser identity (no FK — it
// references the future central identity system); null until that ships.

export const canvassEvents = app.table(
  "canvass_events",
  {
    sequence: bigserial({ mode: "number" }).notNull(),
    clientEventId: text(),
    turfId: uuid()
      .notNull()
      .references(() => turfs.turfId),
    walkId: uuid().references(() => walks.walkId),
    canvasserId: text(),
    canvasserName: text(),
    canvasserPhone: text(),
    personId: text(),
    doorId: text(),
    buildingId: text(),
    kind: text().notNull(),
    payload: jsonb().notNull(),
    inputType: text(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    receivedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.turfId, t.sequence] }),
    uniqueIndex("canvass_events_client_event_id").on(t.clientEventId),
  ],
);

// The single disposition of a result. `null` is the deliberate cleared /
// un-attempt state.
export type CanvassOutcome =
  | "canvassed" // person: made contact (responses ride along)
  | "not_home"
  | "deceased"
  | "hostile"
  | "moved"
  | "address_not_found" // door
  | "inaccessible"; // building

// One question's answer: selected option ids (single- or multi-select) or
// free text.
export type ResponseValue = { optionIds: string[] } | { text: string };

// Payload discriminated union — shared between server and native app.
export type CanvassEventPayload =
  | {
      kind: "result";
      outcome: CanvassOutcome | null;
      responses: Record<string, ResponseValue>; // keyed by questionId
    }
  | { kind: "note"; text: string };

export type CanvassEvent = typeof canvassEvents.$inferSelect;
