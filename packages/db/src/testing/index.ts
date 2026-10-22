export * from "./lifecycle";
import { createDb } from "../client";
import { loadEnv, requireEnv } from "../env";
import { runMigrations } from "../migrate";
import { seed, seedProjectIds, seedStaffUserIds } from "../seed";

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
 * Drops everything transfer_owner owns in a test database and migrates from scratch;
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

/**
 * The seeded projects the participation tests move (Werk Nord, Verwaltung) made active, as the API
 * seed leaves them after pinning and activating through the services (regional-variation.md, snapshot); Lager Süd
 * stays a draft. A test fixture written directly as the owner (round 27): the base seed pins no
 * template, so `activate_project` would refuse these projects.
 */
export const activeSeedProjectIds = [seedProjectIds.werkNord, seedProjectIds.verwaltung] as const;

/** Makes draft projects active directly, as the owner (`client`): a test fixture, never production. */
export async function activateAsOwner(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  projectIds: readonly string[] = activeSeedProjectIds,
): Promise<void> {
  await client.query(
    `update project set status = 'active', activated_at = now(), activated_by = $2
     where id = any($1::uuid[]) and status = 'draft'`,
    [projectIds, seedStaffUserIds.projectLead],
  );
}

/**
 * Empties all tables of transfer_test (as owner) before a test; optionally seeds, and with
 * `active` makes the seeded Werk Nord and Verwaltung active (the draft gate, process-and-lifecycle.md).
 */
export async function resetTestDatabase(
  options: { seed?: boolean; active?: boolean; keepSessions?: boolean } = {},
): Promise<void> {
  const db = createDb(testDatabaseUrls().owner);
  try {
    // A test file logs in once: its live staff sessions survive the reset (unless
    // `keepSessions: false`), since the seed brings its staff users back with the same ids.
    const { rows: sessions } = await db.$client.query(
      "select json_agg(s) as rows from staff_session s where ended_at is null and $1",
      [options.keepSessions ?? true],
    );
    // lifecycle_edge is reference data from the migrations, never truncated.
    await db.$client.query(
      "truncate audit_event, participant_reminder, document_link, document, assisted_mode, self_service_notice_acknowledgement, participant_profile, participant_identifier_data, participant_residence_social_data, participant_health_data, participant_session, one_time_code_challenge, participant_channel, consent_record, participant_account, privacy_notice_delivery, activation_code, participant_assignment, staff_org_role, region, ba_reporting_task, participation_dsv_amendment, import_column_mapping, config_relaxation_request, profiling_exception_request, participant_details, participant_identity, participation, project_entry_wave, project_config_override, project_template_pin, config_template_version, project_membership, project, staff_session, staff_audit_event, staff_user, job_run",
    );
    if (options.seed) {
      await seed(db);
      await db.$client.query(
        `insert into staff_session (token_hash, staff_user_id, created_at, expires_at)
         select token_hash, staff_user_id, created_at, expires_at
         from json_populate_recordset(null::staff_session, $1)
         where staff_user_id in (select id from staff_user)`,
        [JSON.stringify(sessions[0].rows ?? [])],
      );
    }
    if (options.active) await activateAsOwner(db.$client);
  } finally {
    await db.$client.end();
  }
}
