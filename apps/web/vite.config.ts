import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 3000,
  },
  plugins: [
    tanstackStart(),
    // https://tanstack.com/start/latest/docs/framework/react/guide/hosting
    nitro(),
    // React's Vite plugin must come after Start's Vite plugin
    react(),
    tailwindcss(),
  ],
});
