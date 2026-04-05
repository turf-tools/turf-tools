import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PGlite } from "@electric-sql/pglite";

import * as schema from "./schema";

export type Db = PgAsyncDatabase<PgQueryResultHKT, typeof schema>;

const casing = "snake_case" as const;
const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const localDbPath = path.join(pkgDir, "..", "local_db");

function createDb() {
  if (process.env.DATABASE_URL) {
    return drizzlePostgres({
      client: postgres(process.env.DATABASE_URL),
      schema,
      casing,
    });
  }
  return drizzlePglite({
    client: new PGlite(localDbPath),
    schema,
    casing,
  });
}

export const db = createDb() as Db;
