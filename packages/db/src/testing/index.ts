export * from "./lifecycle";
import { createDb } from "../client";
import { loadEnv, requireEnv } from "../env";
import { runMigrations } from "../migrate";
import { seed } from "../seed";

/** Integration tests use transfer_test, Playwright uses transfer_e2e. */
export type TestDatabase = "transfer_test" | "transfer_e2e";

function pointAt(name: string, database: TestDatabase): string {
  const url = new URL(requireEnv(name));
  url.pathname = `/${database}`;
  return url.toString();
}

/** The dev URLs pointed at a test database, so tests can never touch the dev database. */
export function testDatabaseUrls(database: TestDatabase = "transfer_test") {
  loadEnv();
  return {
    app: pointAt("DATABASE_URL", database),
    owner: pointAt("DATABASE_MIGRATION_URL", database),
  };
}

/**
 * Drops everything transfer_owner owns in a test database and migrates from scratch (AC-15);
 * optionally seeds the synthetic data.
 */
export async function recreateTestDatabase(
  database: TestDatabase = "transfer_test",
  options: { seed?: boolean } = {},
): Promise<void> {
  const { owner } = testDatabaseUrls(database);
  const db = createDb(owner);
  try {
    await db.$client.query("drop owned by transfer_owner");
    await runMigrations(owner);
    if (options.seed) await seed(db);
  } finally {
    await db.$client.end();
  }
}

/** Empties all tables of transfer_test (as owner) before a test; optionally seeds. */
export async function resetTestDatabase(options: { seed?: boolean } = {}): Promise<void> {
  const db = createDb(testDatabaseUrls().owner);
  try {
    // lifecycle_edge is reference data from the migrations, never truncated.
    await db.$client.query(
      "truncate audit_event, profiling_exception_request, participation, project_entry_wave, project_template_pin, config_template_version, project_membership, project, staff_user, job_run",
    );
    if (options.seed) await seed(db);
  } finally {
    await db.$client.end();
  }
}
