import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";
import { testDatabaseUrls } from "./testing";

// The upgrade from 0108 to 0109/0110 on existing data (a tested upgrade path for every new
// column): an existing participation is not in the evidence-only phase, stays writable, and has no
// hold; every table naming a participation gets the evidence-only trigger (data-protection.md, the
// evidence-only phase).
const url = testDatabaseUrls().owner;
const folder = mkdtempSync(join(tmpdir(), "transfer-before-legal-hold-"));
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 109);
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

it("upgrades existing participations outside the evidence-only phase, still writable", async () => {
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
  const rows = await db.$client.query(
    "select evidence_set_since from participation where id = $1",
    [person],
  );
  expect(rows.rows).toEqual([{ evidence_set_since: null }]);
  await db.$client.query("update participation set offer_deadline = '2026-03-01' where id = $1", [
    person,
  ]);
  expect((await db.$client.query("select count(*)::int as n from legal_hold")).rows[0].n).toBe(0);
  // Once in the phase, a write is refused.
  await db.$client.query("update participation set evidence_set_since = now() where id = $1", [
    person,
  ]);
  await expect(
    db.$client.query("update participation set offer_deadline = '2026-03-02' where id = $1", [
      person,
    ]),
  ).rejects.toThrow("evidence_set_phase");
  // The new events need a participation.
  await expect(
    db.$client.query(
      `insert into audit_event(project_id,event_type,actor_type,actor_staff_user_id,details)
       values($1,'legal_hold_placed','user',$2,'{}')`,
      [project, user],
    ),
  ).rejects.toMatchObject({ constraint: "audit_event_lifecycle_has_participation" });
});

it("puts the evidence-only trigger on every table naming a participation", async () => {
  const { rows } = await db.$client.query(
    `select c.table_name from information_schema.columns c
     join information_schema.tables t on t.table_name = c.table_name and t.table_schema = c.table_schema
     where c.table_schema = 'public' and c.column_name = 'participation_id'
       and t.table_type = 'BASE TABLE'
       and not exists (select from pg_trigger g where g.tgrelid = ('public.' || c.table_name)::regclass
         and g.tgfoid = 'public.refuse_in_evidence_set_phase'::regproc)
     order by 1`,
  );
  // The audit trail (append-only by its own trigger) and the holds themselves stay writable.
  expect(rows.map((r) => r.table_name)).toEqual(["audit_event", "legal_hold"]);
});
