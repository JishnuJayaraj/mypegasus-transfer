import { createDb } from "../client";
import { loadEnv, refuseInProduction, requireEnv } from "../env";
import { seed } from "../seed";

refuseInProduction("db:seed");
loadEnv();
const db = createDb(requireEnv("DATABASE_MIGRATION_URL"));
try {
  await seed(db);
} finally {
  await db.$client.end();
}
