import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";
import { testDatabaseUrls } from "./testing";

// Offers signed under the participant-only rule keep their signature fact, get a contract and are
// never credited with a packet nobody reviewed.
const url = testDatabaseUrls().owner;
const folder = mkdtempSync(join(tmpdir(), "transfer-before-dsv-packet-"));
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 95);
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
it("backfills the contract of a signed offer without inventing a packet", async () => {
  await db.$client.query("drop owned by transfer_owner");
  await runMigrations(url, folder);
  const [user, project, person, offer, document, wave] = Array.from({ length: 6 }, () =>
    randomUUID(),
  );
  const q = (text: string, values: unknown[]) => db.$client.query(text, values);
  await q("insert into staff_user(id,display_name,email) values($1,'Synthetic','s@example.org')", [
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
    "insert into participation(id,project_id,status,profiling_status,dsv_status,entry_wave_id) values($1,$2,'informed','not_started','dsv_signed',$3)",
    [person, project, wave],
  );
  await q(
    `insert into dsv_offer(id,project_id,participation_id,origin,template_version,offer_deadline,printed_tg_start,printed_tg_end,offered_by,ended_as,ended_at)
     values($1,$2,$3,'external_paper','external_unknown','2091-02-15','2091-03-01','2092-02-28',$4,'signed',now())`,
    [offer, project, person, user],
  );
  await q(
    `insert into document(id,project_id,participation_id,type,catalog_version,retention_class,media_type,size_bytes,content_sha256,key_id,wrapped_key,added_by,added_by_staff_user_id,added_on_behalf,review_state,reviewed_by,reviewed_at,dsv_offer_id,dsv_received_by,dsv_received_on)
     values($1,$2,$3,'dsv_signed_scan',9,'personnel_file','application/pdf',100,repeat('a',64),repeat('b',16),decode(repeat('00',60),'hex'),'user',$4,false,'accepted',$4,now(),$5,$4,'2026-01-10')`,
    [document, project, person, user, offer],
  );
  await q(
    "insert into dsv_scan_signature(project_id,participation_id,document_id,kind,signed_on) values($1,$2,$3,'participant','2026-01-09')",
    [project, person, document],
  );
  await runMigrations(url);
  const { rows } = await q(
    "select participant_signed_on::text, customer_signed_on, fully_executed_on, original_location from dsv_contract where dsv_offer_id=$1",
    [offer],
  );
  expect(rows).toEqual([
    {
      participant_signed_on: "2026-01-09",
      customer_signed_on: null,
      fully_executed_on: null,
      original_location: null,
    },
  ]);
});
