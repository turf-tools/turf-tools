import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

const pkgDir = path.dirname(fileURLToPath(import.meta.url));

export default process.env.DATABASE_URL
  ? defineConfig({
      out: "./migrations",
      schema: "./src/schema/index.ts",
      casing: "snake_case",
      dialect: "postgresql",
      dbCredentials: {
        url: process.env.DATABASE_URL,
      },
    })
  : defineConfig({
      schema: "./src/schema/index.ts",
      casing: "snake_case",
      dialect: "postgresql",
      driver: "pglite",
      dbCredentials: {
        url: path.join(pkgDir, "local_db"),
      },
    });
