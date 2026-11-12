import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";
import { testDatabaseUrls } from "./testing";

const url = testDatabaseUrls().owner;
const folder = mkdtempSync(join(tmpdir(), "transfer-before-dsv-scans-"));
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 93);
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
it("upgrades existing documents without inventing receipt or offer linkage", async () => {
  await db.$client.query("drop owned by transfer_owner");
  await runMigrations(url, folder);
  const user = randomUUID(),
    project = randomUUID(),
    person = randomUUID(),
    document = randomUUID();
  await db.$client.query(
    "insert into staff_user(id,display_name,email) values($1,'Synthetic Reviewer','synthetic@example.org')",
    [user],
  );
  await db.$client.query(
    "insert into project(id,name,customer_name,type,created_by) values($1,'Synthetic Project','Synthetic Customer','ta_tg',$2)",
    [project, user],
  );
  await db.$client.query(
    "insert into participation(id,project_id,status,profiling_status,dsv_status) values($1,$2,'informed','not_started','not_offered')",
    [person, project],
  );
  await db.$client.query(
    `insert into document(id,project_id,participation_id,type,catalog_version,retention_class,media_type,size_bytes,content_sha256,key_id,wrapped_key,added_by,added_by_staff_user_id,added_on_behalf)
 values($1,$2,$3,'dsv_signed_scan',8,'personnel_file','application/pdf',100,repeat('a',64),repeat('b',16),decode(repeat('00',60),'hex'),'user',$4,false)`,
    [document, project, person, user],
  );
  await runMigrations(url);
  const { rows } = await db.$client.query(
    "select catalog_version,dsv_offer_id,dsv_received_on,dsv_received_by from document where id=$1",
    [document],
  );
  expect(rows).toEqual([
    { catalog_version: 8, dsv_offer_id: null, dsv_received_on: null, dsv_received_by: null },
  ]);
  expect((await db.$client.query("select * from dsv_facts($1)", [[person]])).rows).toEqual([]);
}, 30_000);
