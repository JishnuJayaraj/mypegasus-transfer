import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";
import { testDatabaseUrls } from "./testing";

// Migrations 0097–0098 on a database with DSV generations and their audit events: the rows stay,
// `record_form_generation` is replaced (one definition, `p_batch_size` added, still executable by
// the runtime role), the new table is empty and select-only, and the new events are known.
const url = testDatabaseUrls().owner;
const folder = mkdtempSync(join(tmpdir(), "transfer-before-clarification-rounds-"));
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 99);
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

it("turns the rows of 0098 into the first steps of their history", async () => {
  await q("drop owned by transfer_owner");
  await runMigrations(url, folder);
  const [user, manager, project, one, two, three] = Array.from({ length: 6 }, () =>
    randomUUID(),
  ) as [string, string, string, string, string, string];
  for (const [id, mail] of [
    [user, "a"],
    [manager, "b"],
  ] as const) {
    await q("insert into staff_user(id,display_name,email) values($1,'Synthetic',$2)", [
      id,
      `${mail}@example.org`,
    ]);
  }
  await q(
    "insert into project(id,name,customer_name,type,created_by) values($1,'P','C','ta_tg',$2)",
    [project, user],
  );
  const wave = randomUUID();
  await q("insert into project_entry_wave(id,project_id,code,name) values($1,$2,'W','Wave')", [
    wave,
    project,
  ]);
  for (const id of [one, two, three]) {
    await q(
      "insert into participation(id,project_id,status,profiling_status,dsv_status,entry_wave_id) values($1,$2,'informed','not_started','dsv_signed',$3)",
      [id, project, wave],
    );
  }
  const row = (participation: string, escalated: boolean, instructed: boolean) =>
    q(
      `insert into entry_clarification(project_id,participation_id,opened_on,pending_code,pending_source,pending_recorded_at,pending_recorded_by,
         escalated_at,escalated_by,instruction_code,instruction_source,instruction_at,instruction_by)
       values($1,$2,'2026-11-02','awaiting_asu_proof','Akte 1',now(),$3,
         ${escalated ? "now()" : "null"},${escalated ? "$3" : "null"},
         ${instructed ? "'dpo_instruction'" : "null"},${instructed ? "'DSB 7'" : "null"},${instructed ? "now()" : "null"},${instructed ? "$4" : "null"})`,
      instructed ? [project, participation, user, manager] : [project, participation, user],
    );
  await row(one, false, false);
  await row(two, true, false);
  await row(three, true, true);

  await runMigrations(url);

  const { rows } = await q(
    `select c.participation_id, c.stage, c.revision,
       (select string_agg(s.seq || ':' || s.kind || ':' || s.code, ',' order by s.seq)
        from entry_clarification_step s where s.clarification_id = c.id) as steps
     from entry_clarification c order by c.revision`,
  );
  expect(rows.map((r) => [r.stage, r.revision, r.steps])).toEqual([
    ["documented", 1, "1:recorded:awaiting_asu_proof"],
    ["escalated", 2, "1:recorded:awaiting_asu_proof,2:escalated:awaiting_asu_proof"],
    [
      "instructed",
      3,
      "1:recorded:awaiting_asu_proof,2:escalated:awaiting_asu_proof,3:instructed:dpo_instruction",
    ],
  ]);
  // One unresolved case per participation, however its planned start moved.
  await expect(
    q(
      `insert into entry_clarification(project_id,participation_id,opened_on,stage,pending_code,pending_source,pending_recorded_at,pending_recorded_by)
       values($1,$2,'2026-11-09','documented','awaiting_profiling','x',now(),$3)`,
      [project, one, user],
    ),
  ).rejects.toMatchObject({ constraint: "entry_clarification_one_unresolved" });
});
