import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import { testDatabaseUrls } from "./testing";

// The upgrade of a database from before evidence corrections (0087, 0088; Q209): an invalidation
// written before corrections existed names no correction, so it can't be verified; it stays
// invalidated (it counts nothing) under the NOT VALID foreign key, while every new value must name
// a correction. Existing ASU registrations and BA reporting tasks stay current. Synthetic rows only.
const url = testDatabaseUrls().owner;
const before0087 = mkdtempSync(join(tmpdir(), "transfer-before-0087-"));

const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 87);
mkdirSync(join(before0087, "meta"));
writeFileSync(join(before0087, "meta/_journal.json"), JSON.stringify(journal));
for (const { tag } of journal.entries) {
  cpSync(join(migrationsFolder, `${tag}.sql`), join(before0087, `${tag}.sql`));
}

const db = createDb(url);
const query = (text: string, params: unknown[] = []) => db.$client.query(text, params);
afterAll(async () => {
  rmSync(before0087, { recursive: true, force: true });
  // Leave a fully migrated database for the next test file.
  await query("drop owned by transfer_owner");
  await runMigrations(url);
  await db.$client.end();
});

const { projectLead } = seedStaffUserIds;
const { werkNord } = seedProjectIds;

beforeEach(async () => {
  await query("drop owned by transfer_owner");
  await runMigrations(url, before0087);
  await query(
    "insert into staff_user (id, display_name, email) values ($1, 'Petra Projektleitung', 'project-lead@example.org')",
    [projectLead],
  );
  await query(
    "insert into project (id, name, customer_name, type, created_by) values ($1, 'Restrukturierung Werk Nord', 'Beispiel Maschinenbau GmbH', 'ta_tg', $2)",
    [werkNord, projectLead],
  );
});

/** A participation of the schema as of 0086; its id. */
async function participation() {
  const { rows } = await query(
    "insert into participation (project_id, status, profiling_status, dsv_status) values ($1, 'informed', 'not_started', 'not_offered') returning id",
    [werkNord],
  );
  return rows[0].id as string;
}

/** An accepted ASU proof, invalidated with `invalidatedBy` (null: valid); its id. */
async function document(participationId: string, invalidatedBy: string | null) {
  const { rows } = await query(
    `insert into document (id, project_id, participation_id, type, catalog_version,
       retention_class, media_type, size_bytes, content_sha256, key_id, wrapped_key, added_by,
       added_by_staff_user_id, added_on_behalf, review_state, reviewed_by, reviewed_at,
       invalidated_by_correction)
     select $1, $2, $3, type, catalog_version, retention_class, 'application/pdf', 2048, $4, $5,
       $6, 'user', $7, false, 'accepted', $7, now(), $8
     from document_type_policy where type = 'asu_proof'
     order by catalog_version desc limit 1
     returning id`,
    [
      randomUUID(),
      werkNord,
      participationId,
      createHash("sha256").update(randomUUID()).digest("hex"),
      randomBytes(8).toString("hex"),
      randomBytes(60),
      projectLead,
      invalidatedBy,
    ],
  );
  return rows[0].id as string;
}

describe("0087_evidence_corrections on an existing database", () => {
  it("keeps a legacy invalidation invalidated and holds the FK for every new value", async () => {
    const id = await participation();
    const legacy = randomUUID();
    const documentId = await document(id, legacy);
    await query(
      `insert into asu_registration (id, project_id, participation_id, channel, registered_on,
         recorded_by)
       values ($1, $2, $3, 'online_self', '2026-01-15', $4)`,
      [randomUUID(), werkNord, id, projectLead],
    );
    await runMigrations(url);
    const { rows } = await query("select invalidated_by_correction from document where id = $1", [
      documentId,
    ]);
    expect(rows).toEqual([{ invalidated_by_correction: legacy }]);
    const current = await query(
      `select count(*)::int as n from asu_registration
       where participation_id = $1 and superseded_by is null and invalidated_by is null`,
      [id],
    );
    expect(current.rows).toEqual([{ n: 1 }]);
    await expect(document(id, randomUUID())).rejects.toMatchObject({
      code: "23503",
      constraint: "document_invalidated_by_correction_evidence_correction_id_fk",
    });
  });
});
