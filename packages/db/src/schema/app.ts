import { pgSchema } from "drizzle-orm/pg-core";

// All application tables live in the `app` schema, never `public` — the
// operational store's namespace, alongside the DuckLake catalogs'
// `catalog`/`catalog_geo` schemas.
export const app = pgSchema("app");
