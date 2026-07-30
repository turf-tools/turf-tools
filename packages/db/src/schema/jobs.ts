import { bigserial, json, jsonb, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./app";

export const JOB_STATUSES = [
  "unstarted",
  "in_progress",
  "completed",
  "waiting_to_retry",
  "permanently_failed",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobStatus = app.table("job_status", {
  status: text().primaryKey().$type<JobStatus>(),
});

export const jobs = app.table("jobs", {
  jobId: uuid().defaultRandom().primaryKey(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  status: text()
    .$type<JobStatus>()
    .notNull()
    .default("unstarted")
    .references(() => jobStatus.status),
  task: text().notNull(),
  payload: jsonb().notNull(),
  failureReason: text(),
  result: jsonb(),
  concurrencyKey: text(),
  lockedByWorkerId: text(),
});

export const jobMessages = app.table(
  "job_messages",
  {
    jobId: uuid()
      .notNull()
      .references(() => jobs.jobId, { onDelete: "cascade" }),
    messageId: bigserial({ mode: "number" }).notNull(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    payload: json().notNull(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.messageId] })],
);
