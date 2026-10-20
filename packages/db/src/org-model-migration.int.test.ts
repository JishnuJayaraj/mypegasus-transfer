import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import { testDatabaseUrls } from "./testing";

// Q126: the flat staff role goes. 0036 maps `project_lead` to `may_create_projects` and `admin` to
// a global org role; the flat regional roles get none (no region is known), nobody else gains a
// role, and projects keep no region until someone sets one.
const url = testDatabaseUrls().owner;
const before0036 = mkdtempSync(join(tmpdir(), "transfer-before-0036-"));

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 36);
mkdirSync(join(before0036, "meta"));
writeFileSync(join(before0036, "meta/_journal.json"), JSON.stringify(journal));
for (const { tag } of journal.entries) {
  cpSync(join(migrationsFolder, `${tag}.sql`), join(before0036, `${tag}.sql`));
}

const db = createDb(url);
afterAll(async () => {
  rmSync(before0036, { recursive: true, force: true });
  // Leave a fully migrated database for the next test file.
  await db.$client.query("drop owned by transfer_owner");
  await runMigrations(url);
  await db.$client.end();
});

describe("0036_regions_org_roles_assignments", () => {
  it("maps the flat role to the project-creation flag and a global admin role", async () => {
    await db.$client.query("drop owned by transfer_owner");
    await runMigrations(url, before0036);
    // Plain SQL in the schema as of 0035.
    const users = Object.entries({
      admin: "admin",
      regionalAdmin: "regional_admin",
      projectLead: "project_lead",
      consultant: "consultant",
      backOffice: "back_office",
      regionalOperationsManager: "regional_operations_manager",
    }) as [keyof typeof seedStaffUserIds, string][];
    for (const [key, role] of users) {
      await db.$client.query(
        "insert into staff_user (id, display_name, email, role) values ($1, $2, $3, $4)",
        [seedStaffUserIds[key], key, `${key}@example.org`, role],
      );
    }
    await db.$client.query(
      "insert into project (id, name, customer_name, type, created_by) values ($1, 'Werk Nord', 'Beispiel GmbH', 'ta_tg', $2)",
      [seedProjectIds.werkNord, seedStaffUserIds.projectLead],
    );

    await runMigrations(url);

    const { rows: flags } = await db.$client.query(
      "select id from staff_user where may_create_projects order by id",
    );
    expect(flags).toEqual([{ id: seedStaffUserIds.projectLead }]);
    const { rows: roles } = await db.$client.query(
      "select staff_user_id, role, region_id, granted_by from staff_org_role",
    );
    expect(roles).toEqual([
      { staff_user_id: seedStaffUserIds.admin, role: "admin", region_id: null, granted_by: null },
    ]);
    const { rows: columns } = await db.$client.query(
      "select column_name from information_schema.columns where table_name = 'staff_user' and column_name = 'role'",
    );
    expect(columns).toEqual([]);
    const { rows: projects } = await db.$client.query("select region_id from project");
    expect(projects).toEqual([{ region_id: null }]);
  });
});
