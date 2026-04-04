import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { PGlite } from "@electric-sql/pglite";

import * as schema from "./schema";

const casing = "snake_case" as const;
const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const localDbPath = path.join(pkgDir, "..", "local_db");

export type Db = PgAsyncDatabase<PgQueryResultHKT>;

export const db: Db = process.env.DATABASE_URL
  ? drizzlePostgres({
      client: postgres(process.env.DATABASE_URL),
      schema,
      casing,
    })
  : drizzlePglite({
      client: new PGlite(localDbPath),
      schema,
      casing,
    });
