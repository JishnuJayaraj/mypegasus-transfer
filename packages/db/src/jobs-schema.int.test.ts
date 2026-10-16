import { Client } from "pg";
import { getRollbackPlans } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobsSchema, jobsSchemaVersion } from "./jobs-schema";
import { runMigrations } from "./migrate";
import { testDatabaseUrls } from "./testing";

// Plan 5.9 (PR 1h-1), spike S2: db:migrate installs and upgrades pg-boss's schema as
// transfer_owner and re-applies the runtime role's grants; transfer_app only uses it.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const permissionDenied = { code: "42501" };

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));

const installedVersion = async () =>
  (await owner.query(`select version::int as version from ${jobsSchema}.version`)).rows[0]?.version;

/** Every pg-boss table (partitioned ones included) the runtime role lacks a DML privilege on. */
async function tablesWithoutDml(): Promise<string[]> {
  const { rows } = await owner.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relkind in ('r', 'p')
       and not (has_table_privilege('transfer_app', c.oid, 'select')
         and has_table_privilege('transfer_app', c.oid, 'insert')
         and has_table_privilege('transfer_app', c.oid, 'update')
         and has_table_privilege('transfer_app', c.oid, 'delete'))`,
    [jobsSchema],
  );
  return rows.map((r) => r.relname);
}

const concurrentIndexes = async () =>
  (
    await owner.query(
      `select indexname from pg_indexes where schemaname = $1 and indexname in
       ('job_common_i15', 'job_common_i16', 'job_common_i17') order by indexname`,
      [jobsSchema],
    )
  ).rows.map((r) => r.indexname);

describe("the pg-boss schema", () => {
  it("is pg-boss@12.38.0's schema version 46, installed by the migrations", async () => {
    expect(jobsSchemaVersion).toBe(46);
    expect(await installedVersion()).toBe(jobsSchemaVersion);
  });

  it("belongs to transfer_owner, like every object in it", async () => {
    const { rows } = await owner.query(
      `select distinct r.rolname from pg_class c
         join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner
       where n.nspname = $1
       union select r.rolname from pg_namespace n join pg_roles r on r.oid = n.nspowner
       where n.nspname = $1`,
      [jobsSchema],
    );
    expect(rows).toEqual([{ rolname: "transfer_owner" }]);
  });

  it("gives transfer_app usage, DML on every table, its sequences and functions", async () => {
    expect(await tablesWithoutDml()).toEqual([]);
    const { rows } = await owner.query(
      `select has_schema_privilege('transfer_app', $1, 'usage') as usage,
              has_schema_privilege('transfer_app', $1, 'create') as "create",
              bool_and(has_function_privilege('transfer_app', p.oid, 'execute')) as execute
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1`,
      [jobsSchema],
    );
    expect(rows).toEqual([{ usage: true, create: false, execute: true }]);
  });

  it.each([
    ["create a table", `create table ${jobsSchema}.intruder (id int)`],
    ["truncate a job table", `truncate ${jobsSchema}.job`],
    ["alter a table", `alter table ${jobsSchema}.queue add column intruder int`],
    ["drop a table", `drop table ${jobsSchema}.schedule`],
  ])("doesn't let transfer_app %s (42501)", async (_label, sql) => {
    await expect(app.query(sql)).rejects.toMatchObject(permissionDenied);
  });

  it("is left as it is by a repeated migration, which re-applies the grants", async () => {
    await owner.query(`revoke all on all tables in schema ${jobsSchema} from transfer_app`);
    expect(await tablesWithoutDml()).not.toEqual([]);
    await runMigrations(urls.owner);
    expect(await installedVersion()).toBe(jobsSchemaVersion);
    expect(await tablesWithoutDml()).toEqual([]);
  });

  it("is upgraded from an older version, with the index builds outside the transaction", async () => {
    await owner.query(getRollbackPlans(jobsSchema, jobsSchemaVersion));
    expect(await installedVersion()).toBe(jobsSchemaVersion - 1);
    // v46 builds these concurrently, after its transaction.
    expect(await concurrentIndexes()).toEqual([]);
    await runMigrations(urls.owner);
    expect(await installedVersion()).toBe(jobsSchemaVersion);
    expect(await concurrentIndexes()).toEqual([
      "job_common_i15",
      "job_common_i16",
      "job_common_i17",
    ]);
    expect(await tablesWithoutDml()).toEqual([]);
  });

  it("refuses a schema newer than the pinned pg-boss (a downgrade)", async () => {
    await owner.query(`update ${jobsSchema}.version set version = $1`, [jobsSchemaVersion + 1]);
    try {
      await expect(runMigrations(urls.owner)).rejects.toThrow(
        `pg-boss schema version ${jobsSchemaVersion + 1} is newer than ${jobsSchemaVersion}`,
      );
    } finally {
      await owner.query(`update ${jobsSchema}.version set version = $1`, [jobsSchemaVersion]);
    }
  });
});
