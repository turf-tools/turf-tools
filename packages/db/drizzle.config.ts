import { defineConfig } from "drizzle-kit";

// Dev fallback — mirror createDb in src/index.ts.
const url =
  process.env.DATABASE_URL ??
  (process.env.NODE_ENV !== "production"
    ? "postgres://postgres:postgres@127.0.0.1:5432/postgres"
    : undefined);
if (!url) {
  throw new Error("DATABASE_URL is required in production.");
}

export default defineConfig({
  out: "./migrations",
  schema: "./src/schema/index.ts",
  casing: "snake_case",
  dialect: "postgresql",
  dbCredentials: { url },
  // Manage only the app's `public` schema. In dev, DuckLake's metadata catalog
  // shares this Postgres in the `ducklake`/`ducklake_geo` schemas — without this
  // filter, `drizzle-kit push` would see those tables as foreign and offer to
  // drop them, corrupting the lake.
  schemaFilter: ["public"],
});
