import { loadEnv, requireEnv } from "../env";
import { runMigrations } from "../migrate";

loadEnv();
await runMigrations(requireEnv("DATABASE_MIGRATION_URL"));
