import { loadEnv, requireEnv } from "../env";
import { runMigrations } from "../migrate";

loadEnv();
const applied = await runMigrations(requireEnv("DATABASE_MIGRATION_URL"));
// File names only (ADR-0002, function sources).
for (const name of applied) process.stdout.write(`function source applied: ${name}\n`);
