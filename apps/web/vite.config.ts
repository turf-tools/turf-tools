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
        tanstackStart({ spa: { enabled: true } }),
        nitro(),
        // React's plugin must come after Start's.
        react(),
        tailwindcss(),
      ],
});
