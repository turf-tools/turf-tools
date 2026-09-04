import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

// Re-export drizzle query helpers so consumers share the same drizzle-orm instance
// as this package's schema (avoids type mismatches across pnpm peer-dep variants).
export {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";

export * from "./ids";

export type Db = PgAsyncDatabase<PgQueryResultHKT, typeof schema>;

const casing = "snake_case" as const;

const DEV_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/postgres";

function createDb() {
  // Fall back to the dev Postgres URL outside production so `pnpm db:*`
  // scripts work cold. Production must set DATABASE_URL explicitly.
  const url =
    process.env.DATABASE_URL ??
    (process.env.NODE_ENV !== "production" ? DEV_DATABASE_URL : undefined);
  if (!url) {
    throw new Error("DATABASE_URL is required in production.");
  }
  return drizzlePostgres({
    client: postgres(url),
    schema,
    casing,
  });
}

// Module-level instantiation. Note that postgres-js is lazy — calling
// `postgres(url)` doesn't open any connection; the first query does.
// Tests import this module (transitively, via the RPC context) but
// construct their own PGlite-backed db and never query through this
// one, so a placeholder DATABASE_URL in tests is harmless.
export const db = createDb() as Db;
