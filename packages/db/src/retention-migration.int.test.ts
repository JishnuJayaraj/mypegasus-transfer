import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";
import { testDatabaseUrls } from "./testing";

// The upgrade to 0107/0108 on existing data (a tested upgrade path for every new column): an
// existing participation's funding is `unknown` with nobody recorded, a project's settlement dates
// are absent, a deleted document keeps its tombstone; nothing is invented.
const url = testDatabaseUrls().owner;
const folder = mkdtempSync(join(tmpdir(), "transfer-before-retention-"));
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 107);
mkdirSync(join(folder, "meta"));
writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
for (const { tag } of journal.entries)
  cpSync(join(migrationsFolder, `${tag}.sql`), join(folder, `${tag}.sql`));
const db = createDb(url);
afterAll(async () => {
  rmSync(folder, { recursive: true, force: true });
  await db.$client.query("drop owned by transfer_owner");
  await runMigrations(url);
  await db.$client.end();
});

it("upgrades existing participations and projects without a funding fact or a date", async () => {
  await db.$client.query("drop owned by transfer_owner");
  await runMigrations(url, folder);
  const user = randomUUID(),
    project = randomUUID(),
    person = randomUUID();
  await db.$client.query(
    "insert into staff_user(id,display_name,email) values($1,'Synthetic Back Office','synthetic@example.org')",
    [user],
  );
  await db.$client.query(
    "insert into project(id,name,customer_name,type,created_by) values($1,'Synthetic Project','Synthetic Customer','ta_tg',$2)",
    [project, user],
  );
  await db.$client.query(
    `insert into participation(id,project_id,status,profiling_status,dsv_status)
     values($1,$2,'imported','not_started','not_offered')`,
    [person, project],
  );
  await runMigrations(url);
  const participation = await db.$client.query(
    "select funded110, funded110_source, funded110_set_by, funded110_set_at from participation where id = $1",
    [person],
  );
  expect(participation.rows).toEqual([
    {
      funded110: "unknown",
      funded110_source: null,
      funded110_set_by: null,
      funded110_set_at: null,
    },
  ]);
  const dates = await db.$client.query(
    "select kug_final_settlement_date, measure110_settlement_date from project where id = $1",
    [project],
  );
  expect(dates.rows).toEqual([
    { kug_final_settlement_date: null, measure110_settlement_date: null },
  ]);
  // The new events need a participation where they name one.
  await expect(
    db.$client.query(
      `insert into audit_event(project_id,event_type,actor_type,actor_staff_user_id,details)
       values($1,'funding_status_set','user',$2,'{}')`,
      [project, user],
    ),
  ).rejects.toMatchObject({ constraint: "audit_event_lifecycle_has_participation" });
});
