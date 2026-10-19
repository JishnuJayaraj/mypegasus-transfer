import { createDb } from "@transfer/db";
import { loadDotEnv } from "../env";
import { seedParticipations } from "../participations/seed";
import { seedParticipantData } from "../participations/seed-identities";
import { seedActivations, seedTemplatePins } from "../projects/seed";
import { loadRelease } from "../projects/template-pins";

// Dev and test tool (`pnpm db:seed`, `pnpm db:reset`): the template pins through the pin service,
// the activations through the activation service, then the synthetic participations through the
// status service and their synthetic identities through write_participant_data, as the runtime
// role, after the base seed (plan 5.10, AC-43; Slice 2 plan 5.5, 5.14).
if (process.env.NODE_ENV === "production") {
  throw new Error("The participation seed refuses to run with NODE_ENV=production");
}
loadDotEnv();
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Missing environment variable DATABASE_URL (see .env.example)");
const db = createDb(url);
try {
  const release = loadRelease(process.env.CONFIG_DIR);
  await seedTemplatePins(db, release);
  await seedActivations(db, release);
  await seedParticipations(db);
  await seedParticipantData(db);
} finally {
  await db.$client.end();
}
