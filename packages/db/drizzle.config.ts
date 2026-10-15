import { defineConfig } from "drizzle-kit";

// `pnpm db:generate` only diffs the schema against the snapshots; it needs no database.
// Grants are hand-written custom migrations: `pnpm db:generate --custom --name <name>`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
