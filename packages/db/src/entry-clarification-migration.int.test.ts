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
const folder = mkdtempSync(join(tmpdir(), "transfer-before-entry-clarification-"));
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 97);
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

it("keeps the generations and their events and replaces the generation function once", async () => {
  await q("drop owned by transfer_owner");
  await runMigrations(url, folder);
  const [user, project, person, doc, generation] = Array.from({ length: 5 }, () => randomUUID());
  await q("insert into staff_user(id,display_name,email) values($1,'Synthetic','s@example.org')", [
    user,
  ]);
  await q(
    "insert into project(id,name,customer_name,type,created_by) values($1,'P','C','ta_tg',$2)",
    [project, user],
  );
  await q(
    "insert into participation(id,project_id,status,profiling_status,dsv_status) values($1,$2,'informed','not_started','not_offered')",
    [person, project],
  );
  await q(
    `insert into document(id,project_id,participation_id,type,catalog_version,retention_class,media_type,size_bytes,content_sha256,key_id,wrapped_key,added_by,added_by_staff_user_id,added_on_behalf)
     values($1,$2,$3,'dsv_form',8,'form_working_copy','application/pdf',100,repeat('a',64),repeat('b',16),decode(repeat('00',60),'hex'),'user',$4,false)`,
    [doc, project, person, user],
  );
  await q(
    `insert into form_generation(id,project_id,participation_id,document_id,form_code,form_version,profile_revision,profiling_revision,assessment_revision,unemployment_revision,source_token,organisation_sha256,confirmed_warnings,anlage,checklist,offer_deadline,deadline_kind,generated_by)
     values($1,$2,$3,$4,'dsv','v1',0,0,0,0,repeat('c',64),repeat('d',64),'{}',false,'[]','2091-02-15','wave',$5)`,
    [generation, project, person, doc, user],
  );
  await q(
    `insert into audit_event(project_id,participation_id,event_type,actor_type,actor_staff_user_id,details)
     values($1,$2,'dsv_form_generated','user',$3,'{"templateVersion":"v1","deadlineKind":"wave"}')`,
    [project, person, user],
  );

  await runMigrations(url);

  expect((await q("select count(*)::int as n from form_generation")).rows[0].n).toBe(1);
  expect(
    (await q("select details from audit_event where event_type::text = 'dsv_form_generated'"))
      .rows[0].details,
  ).toEqual({ templateVersion: "v1", deadlineKind: "wave" });
  const { rows: definitions } = await q(
    `select pg_get_function_identity_arguments(oid) as args from pg_proc
     where proname = 'record_form_generation' and pronamespace = 'public'::regnamespace`,
  );
  expect(definitions).toHaveLength(1);
  expect(definitions[0].args).toContain("p_batch_size integer");
  for (const fn of [
    "record_form_generation",
    "record_entry_clarification",
    "escalate_entry_clarification",
    "record_clarification_instruction",
    "request_entry_clarification_reply",
  ]) {
    const { rows } = await q(
      `select has_function_privilege('transfer_app', p.oid, 'execute') as app,
         has_function_privilege('public', p.oid, 'execute') as public
       from pg_proc p where p.proname = $1 and p.pronamespace = 'public'::regnamespace`,
      [fn],
    );
    expect([fn, rows]).toEqual([fn, [{ app: true, public: false }]]);
  }
  expect((await q("select count(*)::int as n from entry_clarification")).rows[0].n).toBe(0);
  expect(
    (
      await q(
        `select has_table_privilege('transfer_app', 'entry_clarification', 'select') as sel,
           has_table_privilege('transfer_app', 'entry_clarification', 'insert') as ins,
           has_table_privilege('transfer_app', 'entry_clarification', 'update') as upd`,
      )
    ).rows[0],
  ).toEqual({ sel: true, ins: false, upd: false });
  const { rows: projections } = await q(
    `select event_type::text as type, stream, detail_keys from audit_event_projection
     where event_type::text like 'entry_clarification_%' order by 1`,
  );
  expect(projections).toEqual([
    { type: "entry_clarification_escalated", stream: "case", detail_keys: ["pendingCode"] },
    { type: "entry_clarification_instructed", stream: "case", detail_keys: ["instructionCode"] },
    { type: "entry_clarification_recorded", stream: "case", detail_keys: ["pendingCode"] },
    { type: "entry_clarification_requested", stream: "case", detail_keys: ["requestCode"] },
  ]);
});
