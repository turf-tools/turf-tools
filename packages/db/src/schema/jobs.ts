import {
  bigserial,
  json,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const JOB_STATUSES = [
  "unstarted",
  "in_progress",
  "completed",
  "waiting_to_retry",
  "permanently_failed",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobStatus = pgTable("job_status", {
  status: text().primaryKey().$type<JobStatus>(),
});

export const jobs = pgTable("jobs", {
  jobId: uuid().defaultRandom().primaryKey(),
  status: text()
    .$type<JobStatus>()
    .notNull()
    .default("unstarted")
    .references(() => jobStatus.status),
  task: text().notNull(),
  payload: jsonb().notNull(),
  failureReason: text(),
  result: jsonb(),
  lockedByWorkerId: text(),
});

export const jobMessages = pgTable(
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
