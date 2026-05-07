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

// Module-level instantiation. Note that postgres-js is lazy — calling
// `postgres(url)` doesn't open any connection; the first query does.
// Tests import this module (transitively, via the RPC context) but
// construct their own PGlite-backed db and never query through this
// one, so a placeholder DATABASE_URL in tests is harmless.
export const db = createDb() as Db;
