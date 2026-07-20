// Provision the Postgres database Quickwit uses for its metastore. It lives in
// its own database (NOT the app's `public` schema — Quickwit creates ~15 tables)
// so the running searcher and a separate `local-ingest` process can safely share
// an index. Run before `quickwit run` (dev:search) and in db:setup.
//
//   tsx src/ensure-quickwit-db.ts          # create if absent
//   tsx src/ensure-quickwit-db.ts --reset  # drop + recreate (wipes the metastore,
//                                             to match a qwdata/ split wipe)
import postgres from "postgres";

const DB_NAME = "quickwit";
const reset = process.argv.includes("--reset");

// Connect to the maintenance DB from DATABASE_URL; CREATE/DROP DATABASE are
// cluster-level, so the connected database doesn't matter.
const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const sql = postgres(url, { max: 1 });

try {
  if (reset) {
    await sql.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
  }
  const existing = await sql`SELECT 1 FROM pg_database WHERE datname = ${DB_NAME}`;
  if (existing.length === 0) {
    await sql.unsafe(`CREATE DATABASE "${DB_NAME}"`);
    console.log(`created database "${DB_NAME}"`);
  } else {
    console.log(`database "${DB_NAME}" already present`);
  }
} finally {
  await sql.end();
}
