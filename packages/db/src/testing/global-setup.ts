import { Client } from "pg";
import type { TestProject } from "vitest/node";
import {
  recreateTestDatabase,
  templateDatabase,
  testDatabaseUrls,
  workerDatabasePattern,
} from "./index";

/** One preparation per Vitest process: the db and api projects both declare this setup. */
const prepared = Symbol.for("@transfer/db/testing/worker-databases");
type Registry = { [prepared]?: Promise<void> };

/**
 * Vitest global setup of the integration projects (ADR-0003, testing): migrates the template
 * `transfer_test` from scratch, drops the worker databases an earlier run left behind (a crashed
 * run included) and clones the template once per worker, `transfer_test_1` to
 * `transfer_test_<maxWorkers>`. Each test file then runs on its worker's clone.
 */
export default async function setup(project: TestProject): Promise<void> {
  const registry = globalThis as Registry;
  await (registry[prepared] ??= prepareWorkerDatabases(project.vitest.config.maxWorkers));
}

async function prepareWorkerDatabases(workers: number): Promise<void> {
  await recreateTestDatabase(templateDatabase);
  // CREATE DATABASE needs a connection to another database than its template.
  const url = new URL(testDatabaseUrls(templateDatabase).owner);
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string }>(
      "select datname as name from pg_database where datname ~ $1 and datdba = (select oid from pg_roles where rolname = current_user)",
      [workerDatabasePattern.source],
    );
    for (const { name } of rows) await client.query(`drop database "${name}"`);
    for (let worker = 1; worker <= workers; worker++) {
      const name = `${templateDatabase}_${worker}`;
      // Objects, their grants and pg-boss's schema come with the copy; database grants don't.
      await client.query(`create database "${name}" template "${templateDatabase}"`);
      await client.query(`grant connect on database "${name}" to transfer_app`);
      // A throwaway database: a commit needn't wait for its WAL flush. What a test sees is the
      // same; only a server crash could lose the last commits.
      await client.query(`alter database "${name}" set synchronous_commit = off`);
    }
  } catch (error) {
    if ((error as { code?: unknown }).code === "42501") {
      throw new Error(
        "transfer_owner may not create the worker databases: run `pnpm db:setup` (it grants CREATEDB in dev and CI, ADR-0003)",
        { cause: error },
      );
    }
    throw error;
  } finally {
    await client.end();
  }
}
