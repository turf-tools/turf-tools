import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

// Re-export drizzle query helpers so consumers share the same drizzle-orm instance
// as this package's schema (avoids type mismatches across pnpm peer-dep variants).
export { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";

export type Db = PgAsyncDatabase<PgQueryResultHKT, typeof schema>;

const casing = "snake_case" as const;

function createDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required. In dev, run `pnpm dev` (which starts a Postgres container and exports DATABASE_URL).",
    );
  }
  return drizzlePostgres({
    client: postgres(process.env.DATABASE_URL),
    schema,
    casing,
  });
}

export const db = createDb() as Db;
