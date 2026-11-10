import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";
import { testDatabaseUrls } from "./testing";

// The upgrade to 0105/0106 on existing data (the plan's lessons: a tested upgrade path): an
// existing correction keeps its target and a confirmed signature row stays current, so the DSV
// facts and the one-row-per-signature index read as before; nothing is invented.
const url = testDatabaseUrls().owner;
const folder = mkdtempSync(join(tmpdir(), "transfer-before-date-corrections-"));
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 105);
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

it("upgrades existing corrections and signature rows without changing a fact", async () => {
  await db.$client.query("drop owned by transfer_owner");
  await runMigrations(url, folder);
  const user = randomUUID(),
    project = randomUUID(),
    person = randomUUID(),
    offer = randomUUID(),
    document = randomUUID(),
    correction = randomUUID(),
    wave = randomUUID();
  await db.$client.query(
    "insert into staff_user(id,display_name,email) values($1,'Synthetic Reviewer','synthetic@example.org')",
    [user],
  );
  await db.$client.query(
    "insert into project(id,name,customer_name,type,created_by) values($1,'Synthetic Project','Synthetic Customer','ta_tg',$2)",
    [project, user],
  );
  await db.$client.query(
    `insert into project_entry_wave (id, project_id, code, name, signing_deadline, default_tg_start, default_tg_end, latest_entry_date)
     values ($1, $2, 'W1', 'W1', '2026-01-05', '2026-02-01', '2027-01-31', '2026-02-15')`,
    [wave, project],
  );
  await db.$client.query(
    `insert into participation(id,project_id,entry_wave_id,status,profiling_status,dsv_status)
     values($1,$2,$3,'informed','not_started','dsv_signed')`,
    [person, project, wave],
  );
  await db.$client.query(
    `insert into dsv_offer(id,project_id,participation_id,origin,template_version,offer_deadline,printed_tg_start,printed_tg_end,offered_by,ended_as,ended_at)
     values($1,$2,$3,'external_paper','external_unknown','2026-01-05','2026-02-01','2027-01-31',$4,'signed',now())`,
    [offer, project, person, user],
  );
  await db.$client.query(
    `insert into document(id,project_id,participation_id,type,catalog_version,retention_class,media_type,size_bytes,content_sha256,key_id,wrapped_key,added_by,added_by_staff_user_id,added_on_behalf,dsv_offer_id,dsv_received_by,dsv_received_on,review_state,reviewed_by,reviewed_at)
     values($1,$2,$3,'dsv_signed_scan',9,'personnel_file','application/pdf',100,repeat('a',64),repeat('b',16),decode(repeat('00',60),'hex'),'user',$4,false,$5,$4,'2026-01-04','accepted',$4,now())`,
    [document, project, person, user, offer],
  );
  await db.$client.query(
    `insert into dsv_scan_signature(project_id,participation_id,document_id,kind,signed_on)
     values($1,$2,$3,'participant','2026-01-03')`,
    [project, person, document],
  );
  await db.$client.query(
    `insert into evidence_correction(id,project_id,participation_id,target_kind,action,document_id,wrong_person,reason,source,retention_class,requested_by)
     values($1,$2,$3,'document','invalidate',$4,false,'documented_internal_error','Akte 1','personnel_file',$5)`,
    [correction, project, person, document, user],
  );
  const facts = async () =>
    (await db.$client.query("select signed_on::text from dsv_facts($1)", [[person]])).rows;
  expect(await facts()).toEqual([{ signed_on: "2026-01-03" }]);
  await runMigrations(url);
  expect(await facts()).toEqual([{ signed_on: "2026-01-03" }]);
  expect(
    (
      await db.$client.query(
        "select superseded_by, correction_id from dsv_scan_signature where document_id=$1",
        [document],
      )
    ).rows,
  ).toEqual([{ superseded_by: null, correction_id: null }]);
  expect(
    (
      await db.$client.query(
        `select target_kind::text, document_id, field_key, dsv_offer_id, corrected_on, original_on,
           status::text from evidence_correction where id=$1`,
        [correction],
      )
    ).rows,
  ).toEqual([
    {
      target_kind: "document",
      document_id: document,
      field_key: null,
      dsv_offer_id: null,
      corrected_on: null,
      original_on: null,
      status: "requested",
    },
  ]);
  // The pending request still blocks a second one of the same document.
  await expect(
    db.$client.query(
      `insert into evidence_correction(project_id,participation_id,target_kind,action,document_id,wrong_person,reason,source,retention_class,requested_by)
       values($1,$2,'document','invalidate',$3,false,'documented_internal_error','Akte 2','personnel_file',$4)`,
      [project, person, document, user],
    ),
  ).rejects.toMatchObject({ code: "23505" });
  // A second current row of the same signature is still refused; a superseded one is not.
  await expect(
    db.$client.query(
      `insert into dsv_scan_signature(project_id,participation_id,document_id,kind,signed_on)
       values($1,$2,$3,'participant','2026-01-02')`,
      [project, person, document],
    ),
  ).rejects.toMatchObject({ code: "23505" });
});
