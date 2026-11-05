import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import { testDatabaseUrls } from "./testing";

// The upgrade of a database holding exception requests from before evidence records existed
// (0086; the review of PR #102): each request keeps its history and gets a `legacy_unverified`
// record, which never counts as evidence; an id shared by two participations stops the migration
// and leaves the database as it was. Synthetic rows only.
const url = testDatabaseUrls().owner;
const before0085 = mkdtempSync(join(tmpdir(), "transfer-before-0085-"));

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 85);
mkdirSync(join(before0085, "meta"));
writeFileSync(join(before0085, "meta/_journal.json"), JSON.stringify(journal));
for (const { tag } of journal.entries) {
  cpSync(join(migrationsFolder, `${tag}.sql`), join(before0085, `${tag}.sql`));
}

const db = createDb(url);
const query = (text: string, params: unknown[] = []) => db.$client.query(text, params);
afterAll(async () => {
  rmSync(before0085, { recursive: true, force: true });
  // Leave a fully migrated database for the next test file.
  await query("drop owned by transfer_owner");
  await runMigrations(url);
  await db.$client.end();
});

const fingerprint = `sha256:v1:${"a".repeat(64)}`;
const legacyId = "00000000-0000-4000-8000-0000000000e1";

/** The schema as of 0084, a project and its PL; returns a new participation's id. */
async function participation() {
  const { rows } = await query(
    "insert into participation (project_id, status, profiling_status, dsv_status) values ($1, 'informed', 'not_started', 'not_offered') returning id",
    [seedProjectIds.werkNord],
  );
  return rows[0].id as string;
}

const request = (participationId: string, status = "requested", evidenceRecordId = legacyId) =>
  query(
    `insert into profiling_exception_request (project_id, participation_id, reason_code, status,
       requested_by, requested_on, evidence_record_id, evidence_fingerprint)
     values ($1, $2, 'force_majeure', $3, $4, '2091-02-01', $5, $6) returning id`,
    [
      seedProjectIds.werkNord,
      participationId,
      status,
      seedStaffUserIds.projectLead,
      evidenceRecordId,
      fingerprint,
    ],
  );

beforeEach(async () => {
  await query("drop owned by transfer_owner");
  await runMigrations(url, before0085);
  await query(
    "insert into staff_user (id, display_name, email) values ($1, 'Petra Projektleitung', 'project-lead@example.org')",
    [seedStaffUserIds.projectLead],
  );
  await query(
    "insert into project (id, name, customer_name, type, created_by) values ($1, 'Restrukturierung Werk Nord', 'Beispiel Maschinenbau GmbH', 'ta_tg', $2)",
    [seedProjectIds.werkNord, seedStaffUserIds.projectLead],
  );
});

describe("0086_exception_evidence_functions on an existing database", () => {
  it("keeps a legacy request with a legacy_unverified record that never counts", async () => {
    const id = await participation();
    await request(id);
    await runMigrations(url);
    const { rows } = await query(
      `select kind::text, participation_id, document_ids, reference, fingerprint, created_by,
         exception_evidence_usable(id) as usable
       from profiling_exception_evidence_record where id = $1`,
      [legacyId],
    );
    expect(rows).toEqual([
      {
        kind: "legacy_unverified",
        participation_id: id,
        document_ids: null,
        reference: null,
        fingerprint,
        created_by: seedStaffUserIds.projectLead,
        usable: false,
      },
    ]);
    // The FK holds from now on: a request names a record of its own participation.
    await expect(request(await participation(), "revoked")).rejects.toMatchObject({
      code: "23503",
      constraint: "profiling_exception_request_evidence_fk",
    });
  });

  it("stops on an evidence id shared by two participations and leaves the database unchanged", async () => {
    await request(await participation(), "revoked");
    await request(await participation(), "revoked");
    await expect(runMigrations(url)).rejects.toThrow(/legacy_evidence_conflict/);
    const { rows } = await query(
      "select to_regclass('public.profiling_exception_evidence_record') as record",
    );
    expect(rows).toEqual([{ record: null }]);
  });
});
