import { createDb } from "../client";
import { loadEnv, refuseInProduction, requireEnv } from "../env";
import { runMigrations } from "../migrate";
import { seed } from "../seed";

// Dev only: drops everything transfer_owner owns in the database, migrates and seeds.
refuseInProduction("db:reset");
loadEnv();
const url = requireEnv("DATABASE_MIGRATION_URL");
const db = createDb(url);
try {
  await db.$client.query("drop owned by transfer_owner");
  await runMigrations(url);
  await seed(db);
} finally {
  await db.$client.end();
}
