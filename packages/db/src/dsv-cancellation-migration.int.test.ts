import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";
import { testDatabaseUrls } from "./testing";

// The upgrade to 0101/0102 on existing data (the plan's lessons: a tested upgrade path): a
// cancellation stored before catalog version 10 and a participation withdrawn on a signed DSV
// keep what they were; nothing is invented (no signature, no fact, no notice).
const url = testDatabaseUrls().owner;
const folder = mkdtempSync(join(tmpdir(), "transfer-before-dsv-cancellation-"));
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 101);
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

it("upgrades an existing cancellation and a signed withdrawal without inventing a fact or a notice", async () => {
  await db.$client.query("drop owned by transfer_owner");
  await runMigrations(url, folder);
  const user = randomUUID(),
    project = randomUUID(),
    person = randomUUID(),
    offer = randomUUID(),
    document = randomUUID(),
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
    `insert into participation(id,project_id,entry_wave_id,status,profiling_status,dsv_status,withdrawn_on,end_reason,end_reason_source)
     values($1,$2,$3,'withdrawn','not_started','dsv_signed','2026-01-10','placed_direct','user')`,
    [person, project, wave],
  );
  await db.$client.query(
    `insert into dsv_offer(id,project_id,participation_id,origin,template_version,offer_deadline,printed_tg_start,printed_tg_end,offered_by,ended_as,ended_at)
     values($1,$2,$3,'external_paper','external_unknown','2026-01-05','2026-02-01','2027-01-31',$4,'signed',now())`,
    [offer, project, person, user],
  );
  await db.$client.query(
    `insert into document(id,project_id,participation_id,type,catalog_version,retention_class,media_type,size_bytes,content_sha256,key_id,wrapped_key,added_by,added_by_staff_user_id,added_on_behalf,dsv_offer_id,review_state,reviewed_by,reviewed_at)
     values($1,$2,$3,'dsv_cancellation',9,'personnel_file','application/pdf',100,repeat('a',64),repeat('b',16),decode(repeat('00',60),'hex'),'user',$4,false,$5,'accepted',$4,now())`,
    [document, project, person, user, offer],
  );
  await runMigrations(url);
  const { rows } = await db.$client.query(
    "select catalog_version, review_state::text from document where id=$1",
    [document],
  );
  expect(rows).toEqual([{ catalog_version: 9, review_state: "accepted" }]);
  // No confirmed signatures: the cancellation supplies no fact; no notice is recorded for anyone.
  expect(
    (await db.$client.query("select * from dsv_cancellation_facts($1)", [[person]])).rows,
  ).toEqual([]);
  expect(
    (await db.$client.query("select count(*)::int as n from dsv_customer_notice")).rows,
  ).toEqual([{ n: 0 }]);
  const { rows: policy } = await db.$client.query(
    "select add_roles, review_roles, delete_roles, quarantine_roles from document_type_policy where type='dsv_cancellation' and catalog_version=10",
  );
  expect(policy).toEqual([
    {
      add_roles: ["project_lead", "back_office"],
      review_roles: ["project_lead", "back_office"],
      delete_roles: ["project_lead"],
      quarantine_roles: ["project_lead", "back_office"],
    },
  ]);
});
