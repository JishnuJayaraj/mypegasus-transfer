import { createDb } from "../client";
import { loadEnv, requireEnv } from "../env";
import { runMigrations } from "../migrate";
import { seed } from "../seed";

function toTest(name: string): string {
  const url = new URL(requireEnv(name));
  url.pathname = "/transfer_test";
  return url.toString();
}

/** The dev URLs pointed at `transfer_test`, so tests can never touch the dev database. */
export function testDatabaseUrls(): { app: string; owner: string } {
  loadEnv();
  return { app: toTest("DATABASE_URL"), owner: toTest("DATABASE_MIGRATION_URL") };
}

/** Drops everything transfer_owner owns in `transfer_test` and migrates from scratch (AC-15). */
export async function recreateTestDatabase(): Promise<void> {
  const { owner } = testDatabaseUrls();
  const db = createDb(owner);
  try {
    await db.$client.query("drop owned by transfer_owner");
  } finally {
    await db.$client.end();
  }
  await runMigrations(owner);
}

/** Empties all tables (as owner) before a test; optionally seeds the synthetic data. */
export async function resetTestDatabase(options: { seed?: boolean } = {}): Promise<void> {
  const db = createDb(testDatabaseUrls().owner);
  try {
    await db.$client.query("truncate project, staff_user");
    if (options.seed) await seed(db);
  } finally {
    await db.$client.end();
  }
}
