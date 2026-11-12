import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createDb } from "./client";
import { erasureDeferredForeignKeys } from "./data-catalog";
import { migrationsFolder, runMigrations } from "./migrate";
import { testDatabaseUrls } from "./testing";

const url = testDatabaseUrls().owner;
const folder = mkdtempSync(join(tmpdir(), "transfer-before-erasure-"));
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 111);
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

it("upgrades 0110 with existing audit events and keeps foreign keys initially immediate", async () => {
  await db.$client.query("drop owned by transfer_owner");
  await runMigrations(url, folder);
  const user = randomUUID(),
    project = randomUUID(),
    subject = randomUUID();
  await db.$client.query(
    `insert into staff_user(id, display_name, email) values ($1, 'Synthetic User', 'synthetic@example.org')`,
    [user],
  );
  await db.$client.query(
    `insert into project(id, name, customer_name, type, created_by) values ($1, 'Synthetic', 'Synthetic', 'ta_tg', $2)`,
    [project, user],
  );
  await db.$client.query(
    `insert into participation(id, project_id, status, profiling_status, dsv_status) values ($1, $2, 'imported', 'not_started', 'not_offered')`,
    [subject, project],
  );
  await db.$client.query(
    `insert into audit_event(project_id, participation_id, event_type, actor_type, actor_staff_user_id, field, to_value) values ($1, $2, 'participation_created', 'user', $3, 'status', 'imported')`,
    [project, subject, user],
  );
  const consent = randomUUID(),
    channel = randomUUID();
  await db.$client.query(
    `insert into consent_record (id, project_id, participation_id, purpose, source, channel_id, text_version, language, actor_type)
    values ($1, $2, $3, 'portal_contact', 'portal', $4, 'consent:v1', 'de', 'participant')`,
    [consent, project, subject, channel],
  );
  await db.$client.query(
    `insert into participant_channel (id, project_id, participation_id, kind, address, verified_by, consent_id)
    values ($1, $2, $3, 'email', 'synthetic@example.org', 'one_time_code', $4)`,
    [channel, project, subject, consent],
  );
  await runMigrations(url);
  expect(
    (await db.$client.query(`select address from participant_channel where id = $1`, [channel]))
      .rows,
  ).toEqual([{ address: "synthetic@example.org" }]);
  await expect(
    db.$client.query(`update participant_channel set address = null where id = $1`, [channel]),
  ).rejects.toMatchObject({ constraint: "participant_channel_address_retained" });
  const constraints = await db.$client.query(
    `select conname, condeferrable, condeferred from pg_constraint where conname = any($1::text[]) order by conname`,
    [erasureDeferredForeignKeys],
  );
  expect(constraints.rows).toEqual(
    erasureDeferredForeignKeys
      .toSorted()
      .map((conname) => ({ conname, condeferrable: true, condeferred: false })),
  );
  const events = await db.$client.query(
    `select participation_id from audit_event where project_id = $1`,
    [project],
  );
  expect(events.rows).toEqual([{ participation_id: subject }]);
  await expect(
    db.$client.query(`update participation set profiling_exception_request_id = $2 where id = $1`, [
      subject,
      randomUUID(),
    ]),
  ).rejects.toMatchObject({ constraint: "participation_current_exception_request_fk" });
  for (const column of [
    "erasure_pending_at",
    "erasure_entered_tg",
    "erasure_trigger",
    "erasure_trigger_on",
  ]) {
    const privileges = await db.$client.query(
      `select
      has_column_privilege('transfer_app', 'participation', $1, 'SELECT') as app_read,
      has_column_privilege('transfer_app', 'participation', $1, 'UPDATE') as app_write,
      has_column_privilege('transfer_retention', 'participation', $1, 'UPDATE') as retention_write`,
      [column],
    );
    expect(privileges.rows).toEqual([{ app_read: true, app_write: false, retention_write: false }]);
  }
  const entrypoints = [
    "retention_erase_participation(uuid,uuid)",
    "retention_lock_working_copy(uuid,uuid)",
    "retention_working_copies(uuid)",
    "retention_lock_erasure_projects(uuid)",
    "retention_erasure_facts(uuid)",
    "retention_purge_working_copy(uuid,uuid)",
  ];
  for (const name of entrypoints) {
    const privileges = await db.$client.query(
      `select has_function_privilege('transfer_retention', $1, 'EXECUTE') as retention,
      has_function_privilege('transfer_app', $1, 'EXECUTE') as app`,
      [name],
    );
    expect(privileges.rows).toEqual([{ retention: true, app: false }]);
  }
  for (const name of ["retention_scrub_text(text)", "retention_scrub_json(jsonb,boolean,text)"]) {
    const privileges = await db.$client.query(
      `select has_function_privilege('transfer_retention', $1, 'EXECUTE') as retention,
      has_function_privilege('transfer_app', $1, 'EXECUTE') as app`,
      [name],
    );
    expect(privileges.rows).toEqual([{ retention: false, app: false }]);
  }
  const app = createDb(testDatabaseUrls().app),
    retention = createDb(testDatabaseUrls().retention);
  try {
    await expect(
      app.$client.query(`select retention_erase_participation($1::uuid, $2::uuid)`, [
        randomUUID(),
        subject,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      retention.$client.query(`select retention_erase_participation($1::uuid, $2::uuid)`, [
        randomUUID(),
        subject,
      ]),
    ).rejects.toThrow("run_not_open");
    await expect(
      retention.$client.query(`delete from participation where id = $1`, [subject]),
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await Promise.all([app.$client.end(), retention.$client.end()]);
  }
});
