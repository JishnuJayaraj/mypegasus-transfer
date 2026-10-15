import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The image bundle (plan section 5.7): `dist/server.js` and `dist/migrate.js`. Workspace
// packages (`@transfer/*`, devDependencies) are inlined. npm dependencies stay external and
// come from `pnpm deploy --prod`, so whatever the bundle imports at runtime must be a
// dependency of this package (e.g. `drizzle-orm` and `pg` for `@transfer/db`).
const migrations = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

export default defineConfig({
  build: {
    ssr: true,
    outDir: "dist",
    target: "node22",
    rolldownOptions: {
      input: { server: "src/server.ts", migrate: "src/migrate.ts" },
      // Shared chunks next to the entries, not in dist/assets: modules resolve paths relative
      // to `import.meta.url` (e.g. `.env`), which must be one level below apps/api like src/.
      output: { chunkFileNames: "[name]-[hash].js" },
    },
  },
  ssr: { noExternal: [/^@transfer\//] },
  plugins: [
    {
      name: "copy-migrations",
      // dist/migrate.js applies the SQL migrations from dist/migrations.
      writeBundle: () => cpSync(migrations, "dist/migrations", { recursive: true }),
    },
  ],
});
