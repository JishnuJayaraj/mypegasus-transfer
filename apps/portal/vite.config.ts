import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The portal lives under /portal/ (dev, preview and the image, where the API serves it).
// /api goes to the API: `pnpm dev` runs it on 3001.
const proxy = { "/api": process.env.API_URL ?? "http://localhost:3001" };

export default defineConfig({
  base: "/portal/",
  resolve: {
    // Carbon's font URLs use webpack's `~@ibm/plex`; @ibm/plex is a direct dependency here.
    alias: [
      {
        find: /^~@ibm\/plex/,
        replacement: fileURLToPath(new URL("node_modules/@ibm/plex", import.meta.url)),
      },
    ],
  },
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react()],
  css: {
    // Carbon emits Sass deprecation warnings; silence them for dependencies only (spike S3).
    preprocessorOptions: { scss: { quietDeps: true } },
  },
  server: { port: 5174, strictPort: true, proxy },
  preview: { port: 4174, strictPort: true, proxy },
});
