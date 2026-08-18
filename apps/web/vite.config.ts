import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite-plus";

const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 3000,
    host: "0.0.0.0",
  },
  ssr: {
    noExternal: ["@turf-tools/db", "@electric-sql/pglite"],
  },
  plugins: isTest
    ? []
    : [
        // Server-rendered: route loaders run during SSR and their query data
        // ships with the document, so a page paints with content instead of
        // fetching it after hydration. The trade is time-to-first-byte —
        // the server now runs auth + loaders before it can respond, and the
        // browser holds the previous paint until it does.
        tanstackStart(),
        nitro(),
        // React's plugin must come after Start's.
        react(),
        tailwindcss(),
      ],
});
