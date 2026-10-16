import { getConstructionPlans, getMigrationPlans } from "pg-boss";
import pgBossPackage from "pg-boss/package.json" with { type: "json" };
import type { PoolClient } from "pg";

/** pg-boss's schema (ADR-0011): owned by transfer_owner, used by transfer_app. */
export const jobsSchema = "pgboss";

/** The schema version the pinned pg-boss expects (`pg-boss@12.38.0`: 46). */
export const jobsSchemaVersion: number = pgBossPackage.pgboss.schema;

/**
 * What the runtime role needs (spike S2): usage, DML on every table, the sequences and functions;
 * no `CREATE`, no DDL. On existing objects only, so it is re-applied after every install or
 * upgrade. `persistQueueStats` and partitioned queues would need DDL at runtime: both stay off.
 */
const grants = `
  GRANT USAGE ON SCHEMA ${jobsSchema} TO transfer_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${jobsSchema} TO transfer_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${jobsSchema} TO transfer_app;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${jobsSchema} TO transfer_app;
`;

/**
 * pg-boss's exported upgrade script: one transaction, then the index builds it inlines as
 * `CREATE INDEX CONCURRENTLY` after the `COMMIT`, which must run one by one outside it.
 */
async function upgrade(client: PoolClient, from: number): Promise<void> {
  const script = getMigrationPlans(jobsSchema, from);
  const end = script.lastIndexOf("COMMIT;") + "COMMIT;".length;
  await client.query(script.slice(0, end));
  for (const statement of script.slice(end).split(/;\s*\n/)) {
    if (statement.replace(/^\s*--.*$/gm, "").trim()) await client.query(statement);
  }
}

/**
 * Installs pg-boss's schema, or upgrades it to the pinned version, and (re)applies the runtime
 * grants. Runs as transfer_owner after the app migrations (`db:migrate`, `dist/migrate.js`); the
 * API starts pg-boss with its own migration off. A newer schema (a downgrade) is refused.
 */
export async function installJobsSchema(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ installed: boolean }>(
    "select to_regclass($1) is not null as installed",
    [`${jobsSchema}.version`],
  );
  if (!rows[0]!.installed) {
    await client.query(getConstructionPlans(jobsSchema));
  } else {
    const { rows: versions } = await client.query<{ version: number }>(
      `select version::int as version from ${jobsSchema}.version`,
    );
    const installed = versions[0]!.version;
    if (installed > jobsSchemaVersion) {
      throw new Error(
        `pg-boss schema version ${installed} is newer than ${jobsSchemaVersion} (pinned pg-boss)`,
      );
    }
    if (installed < jobsSchemaVersion) await upgrade(client, installed);
  }
  await client.query(grants);
}
