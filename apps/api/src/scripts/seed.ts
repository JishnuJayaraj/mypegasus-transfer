import { createDb } from "@transfer/db";
import { loadDotEnv } from "../env";
import { seedParticipations } from "../participations/seed";

// Dev and test tool (`pnpm db:seed`, `pnpm db:reset`): the synthetic participations, through the
// status service as the runtime role, after the base seed (plan 5.10, AC-43).
if (process.env.NODE_ENV === "production") {
  throw new Error("The participation seed refuses to run with NODE_ENV=production");
}
loadDotEnv();
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Missing environment variable DATABASE_URL (see .env.example)");
const db = createDb(url);
try {
  await seedParticipations(db);
} finally {
  await db.$client.end();
}
