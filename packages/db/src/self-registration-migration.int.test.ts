import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import { testDatabaseUrls } from "./testing";

// process-and-lifecycle.md: there is no self-registration, so 0033 removes `self_registered` and
// `rejected` from main_status. A database holding one is refused rather than converted.
const url = testDatabaseUrls().owner;
const before0033 = mkdtempSync(join(tmpdir(), "transfer-before-0033-"));

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 33);
mkdirSync(join(before0033, "meta"));
writeFileSync(join(before0033, "meta/_journal.json"), JSON.stringify(journal));
for (const { tag } of journal.entries) {
  cpSync(join(migrationsFolder, `${tag}.sql`), join(before0033, `${tag}.sql`));
}

const db = createDb(url);
afterAll(async () => {
  rmSync(before0033, { recursive: true, force: true });
  // Leave a fully migrated database for the next test file.
  await db.$client.query("drop owned by transfer_owner");
  await runMigrations(url);
  await db.$client.end();
});

describe("0033_remove_self_registration", () => {
  it("refuses a database holding a removed status and leaves it unchanged", async () => {
    await db.$client.query("drop owned by transfer_owner");
    await runMigrations(url, before0033);
    // Plain SQL in the schema as of 0032: the seed writes today's schema, which later migrations
    // extend (e.g. `staff_user`'s OIDC columns).
    await db.$client.query(
      "insert into staff_user (id, display_name, email, role) values ($1, 'Petra Projektleitung', 'project-lead@example.org', 'project_lead')",
      [seedStaffUserIds.projectLead],
    );
    await db.$client.query(
      "insert into project (id, name, customer_name, type, created_by) values ($1, 'Restrukturierung Werk Nord', 'Beispiel Maschinenbau GmbH', 'ta_tg', $2)",
      [seedProjectIds.werkNord, seedStaffUserIds.projectLead],
    );
    await db.$client.query(
      "insert into participation (project_id, status, profiling_status, dsv_status) values ($1, 'self_registered', 'not_started', 'not_offered')",
      [seedProjectIds.werkNord],
    );

    await expect(runMigrations(url)).rejects.toThrow(/self_registration_data_present/);
    const { rows } = await db.$client.query(
      "select enum_range(null::main_status)::text[] as values",
    );
    expect(rows[0].values).toContain("self_registered");
  });
});
