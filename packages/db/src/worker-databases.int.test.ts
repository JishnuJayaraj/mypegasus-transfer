import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobsSchema, jobsSchemaVersion } from "./jobs-schema";
import { migrationsFolder } from "./migrate";
import { templateDatabase, testDatabaseUrls, workerDatabase } from "./testing";

// The integration tests' databases (ADR-0003, testing): each Vitest worker runs its files on its
// own clone of the migrated template, for both roles, with pg-boss's schema and its grants.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
beforeAll(async () => {
  await app.connect();
  await owner.connect();
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

describe("the worker's test database", () => {
  it("is this worker's clone, never the template, for both roles", async () => {
    const name = `${templateDatabase}_${process.env.VITEST_POOL_ID}`;
    expect(workerDatabase()).toBe(name);
    const query = "select current_database() as database, current_user as role";
    expect((await app.query(query)).rows).toEqual([{ database: name, role: "transfer_app" }]);
    expect((await owner.query(query)).rows).toEqual([{ database: name, role: "transfer_owner" }]);
  });

  it("is transfer_owner's, and transfer_app may connect as to the databases of db:setup", async () => {
    const { rows } = await owner.query(
      `select pg_get_userbyid(datdba) as owner,
              has_database_privilege('transfer_app', datname, 'CONNECT') as app_connects
       from pg_database where datname = current_database()`,
    );
    expect(rows).toEqual([{ owner: "transfer_owner", app_connects: true }]);
  });

  it("carries every migration, and pg-boss's schema with the runtime role's grants", async () => {
    const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
    const { rows: migrations } = await owner.query(
      "select count(*)::int as applied from drizzle.__drizzle_migrations",
    );
    expect(migrations).toEqual([{ applied: journal.entries.length }]);
    const { rows: versions } = await owner.query(
      `select version::int as version from ${jobsSchema}.version`,
    );
    expect(versions).toEqual([{ version: jobsSchemaVersion }]);
    const { rows: grants } = await app.query(
      `select has_schema_privilege($1, 'USAGE') as usage,
              has_table_privilege($2, 'SELECT, INSERT, UPDATE, DELETE') as job_dml`,
      [jobsSchema, `${jobsSchema}.job`],
    );
    expect(grants).toEqual([{ usage: true, job_dml: true }]);
  });
});
