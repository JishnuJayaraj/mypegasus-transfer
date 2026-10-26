import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The image bundle (plan section 5.7): `dist/server.js`, `dist/migrate.js` and `dist/parse-worker.js`. Workspace
// packages (`@transfer/*`, devDependencies) are inlined. npm dependencies stay external and
// come from `pnpm deploy --prod`, so whatever the bundle imports at runtime must be a
// dependency of this package (e.g. `drizzle-orm` and `pg` for `@transfer/db`).
const migrations = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));
// The configuration the API reads at runtime (Slice 2 plan 5.8, spike S2), in CONFIG_DIR's layout.
const templates = fileURLToPath(new URL("../../packages/config/templates", import.meta.url));
const baseDefaults = fileURLToPath(
  new URL("../../packages/domain/config/base-defaults.json", import.meta.url),
);
const organisation = fileURLToPath(
  new URL("../../packages/config/organisation.json", import.meta.url),
);
// The form registry and its font (ADR-0009), read by generation at runtime.
const forms = fileURLToPath(new URL("../../packages/forms/templates", import.meta.url));
const fonts = fileURLToPath(new URL("../../packages/forms/fonts", import.meta.url));

export default defineConfig({
  build: {
    ssr: true,
    outDir: "dist",
    target: "node22",
    rolldownOptions: {
      input: {
        server: "src/server.ts",
        migrate: "src/migrate.ts",
        // The import parse worker (Slice 2 plan 5.11, spike S1), started by parse.ts.
        "parse-worker": "src/imports/parse-worker.ts",
      },
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
    {
      name: "copy-config",
      // dist/server.js reads them from CONFIG_DIR=dist/config (the image and `pnpm start`).
      writeBundle: () => {
        cpSync(templates, "dist/config/templates", { recursive: true });
        cpSync(baseDefaults, "dist/config/base-defaults.json");
        cpSync(organisation, "dist/config/organisation.json");
        cpSync(forms, "dist/config/forms/templates", { recursive: true });
        cpSync(fonts, "dist/config/forms/fonts", { recursive: true });
      },
    },
  ],
});
