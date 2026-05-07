import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for drizzle-kit. In dev, run via `pnpm db:push` / `pnpm db:studio` after `pnpm dev` (which exports DATABASE_URL).",
  );
}

export default defineConfig({
  out: "./migrations",
  schema: "./src/schema/index.ts",
  casing: "snake_case",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
