import { runMigrations } from "@transfer/db";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./env";

// Image entry: `node dist/migrate.js` applies the migrations bundled into dist/migrations as
// transfer_owner (a separate command; a Job on the cluster, Slice 9). In dev: `pnpm db:migrate`.
loadDotEnv();
const url = process.env.DATABASE_MIGRATION_URL;
if (!url) throw new Error("Missing environment variable DATABASE_MIGRATION_URL");
await runMigrations(url, fileURLToPath(new URL("./migrations", import.meta.url)));
