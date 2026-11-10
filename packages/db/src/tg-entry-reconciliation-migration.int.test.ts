import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";
import { testDatabaseUrls } from "./testing";

// Migrations 0103–0104 on a database with participations entered before them, one by a
// reconciliation flagged for review: the rows and the events stay, no review row is invented for an
// entry the review didn't exist for, the new tables are empty and select-only for the runtime role,
// the three new events are known to their projection and refused to `record_audit_event`, and the
// recreated functions keep one definition each.
const url = testDatabaseUrls().owner;
const folder = mkdtempSync(join(tmpdir(), "transfer-before-reconciliation-"));
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 103);
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
const q = (text: string, values: unknown[] = []) => db.$client.query(text, values);

it("keeps the entries made before it and invents no review", async () => {
  await q("drop owned by transfer_owner");
  await runMigrations(url, folder);
  const [user, project, wave, entered, waiting] = Array.from({ length: 5 }, () => randomUUID()) as [
    string,
    string,
    string,
    string,
    string,
  ];
  await q("insert into staff_user(id,display_name,email) values($1,'Synthetic','a@example.org')", [
    user,
  ]);
  await q(
    "insert into project(id,name,customer_name,type,created_by) values($1,'P','C','ta_tg',$2)",
    [project, user],
  );
  await q("insert into project_entry_wave(id,project_id,code,name) values($1,$2,'W','Wave')", [
    wave,
    project,
  ]);
  await q(
    "insert into participation(id,project_id,status,profiling_status,dsv_status,entry_wave_id,tg_entry_date) values($1,$2,'active_in_tg','not_started','dsv_signed',$3,'2026-10-01')",
    [entered, project, wave],
  );
  await q(
    "insert into participation(id,project_id,status,profiling_status,dsv_status,entry_wave_id) values($1,$2,'informed','not_started','dsv_signed',$3)",
    [waiting, project, wave],
  );
  // The entry as the status function wrote it before 0104: flagged for review, no row.
  await q(
    `insert into audit_event(project_id, participation_id, event_type, actor_type, actor_staff_user_id,
       field, from_value, to_value, effective_date, details, flagged_for_review)
     values ($1, $2, 'status_changed', 'user', $3, 'status', 'informed', 'active_in_tg',
       '2026-10-01', '{"entryKind":"reconciliation"}', true)`,
    [project, entered, user],
  );

  await runMigrations(url);

  const { rows: participations } = await q(
    "select id, status, tg_entry_date::text from participation where project_id=$1 order by status::text",
    [project],
  );
  expect(participations).toEqual([
    { id: entered, status: "active_in_tg", tg_entry_date: "2026-10-01" },
    { id: waiting, status: "informed", tg_entry_date: null },
  ]);
  expect(
    (await q("select count(*)::int as n from audit_event where participation_id=$1", [entered]))
      .rows[0].n,
  ).toBe(1);
  expect((await q("select count(*)::int as n from tg_entry_reconciliation")).rows[0].n).toBe(0);
  const { rows: projections } = await q(
    `select event_type, stream::text, detail_keys from audit_event_projection
     where event_type in ('tg_entry_reconciled', 'reconciliation_reviewed', 'reconciliation_replied')
     order by event_type`,
  );
  expect(projections).toEqual([
    { event_type: "reconciliation_replied", stream: "review", detail_keys: [] },
    { event_type: "reconciliation_reviewed", stream: "review", detail_keys: [] },
    { event_type: "tg_entry_reconciled", stream: "case", detail_keys: ["evidenceKinds"] },
  ]);
  // A new event without its participation is refused by the check constraint.
  await expect(
    q(
      `insert into audit_event(project_id, event_type, actor_type, actor_staff_user_id, details)
       values ($1, 'tg_entry_reconciled', 'user', $2, '{}')`,
      [project, user],
    ),
  ).rejects.toMatchObject({ constraint: "audit_event_lifecycle_has_participation" });
  const { rows: definitions } = await q(
    `select proname, count(*)::int as n,
       bool_and(has_function_privilege('transfer_app', p.oid, 'execute')) as app
     from pg_proc p where proname in ('apply_status_change', 'record_audit_event',
       'reconcile_tg_entry', 'review_reconciliation', 'reply_reconciliation_clarification')
     group by proname order by proname`,
  );
  expect(definitions).toEqual([
    { proname: "apply_status_change", n: 1, app: false },
    { proname: "reconcile_tg_entry", n: 1, app: true },
    { proname: "record_audit_event", n: 1, app: true },
    { proname: "reply_reconciliation_clarification", n: 1, app: true },
    { proname: "review_reconciliation", n: 1, app: true },
  ]);
  for (const table of ["tg_entry_reconciliation", "tg_entry_reconciliation_step"]) {
    const { rows } = await q(
      `select has_table_privilege('transfer_app', $1, 'select') as s,
         has_table_privilege('transfer_app', $1, 'insert,update,delete') as w`,
      [table],
    );
    expect(rows[0]).toEqual({ s: true, w: false });
  }
});
