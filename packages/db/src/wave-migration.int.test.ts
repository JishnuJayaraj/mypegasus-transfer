import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";
import { project, projectEntryWave } from "./schema";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import { testDatabaseUrls } from "./testing";

// AC-20: migrating a Slice 0 database gives each ta_tg project one wave W1 with its dates.
const url = testDatabaseUrls().owner;
const slice0Folder = mkdtempSync(join(tmpdir(), "transfer-slice0-"));

/** The migrations up to the end of Slice 0 (0000_init, 0001_grants). */
function writeSlice0Migrations() {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.slice(0, 2);
  mkdirSync(join(slice0Folder, "meta"));
  writeFileSync(join(slice0Folder, "meta/_journal.json"), JSON.stringify(journal));
  for (const { tag } of journal.entries) {
    cpSync(join(migrationsFolder, `${tag}.sql`), join(slice0Folder, `${tag}.sql`));
  }
}

const db = createDb(url);
beforeAll(() => writeSlice0Migrations());
afterAll(async () => {
  rmSync(slice0Folder, { recursive: true, force: true });
  await db.$client.end();
});

describe("the Slice 0 → Slice 1 migration (AC-20)", () => {
  it("creates one wave W1 per ta_tg project from the project's dates", async () => {
    await db.$client.query("drop owned by transfer_owner");
    await runMigrations(url, slice0Folder);
    // The Slice 0 seed's projects: two ta_tg (one with dates, one without) and a ta_only one.
    await db.$client.query(
      "insert into staff_user (id, display_name, email, role) values ($1, 'Petra Projektleitung', 'project-lead@example.org', 'project_lead')",
      [seedStaffUserIds.projectLead],
    );
    await db.$client.query(
      `insert into project (id, name, customer_name, type, signing_deadline, default_tg_start, default_tg_end, created_by) values
        ($1, 'Restrukturierung Werk Nord', 'Beispiel Maschinenbau GmbH', 'ta_tg', '2027-02-15', '2027-03-01', '2028-02-29', $4),
        ($2, 'Standortschließung Lager Süd', 'Musterfirma Logistik AG', 'ta_tg', null, null, null, $4),
        ($3, 'Transferagentur Verwaltung', 'Fiktiv Versicherungen KG', 'ta_only', null, null, null, $4)`,
      [
        seedProjectIds.werkNord,
        seedProjectIds.lagerSued,
        seedProjectIds.verwaltung,
        seedStaffUserIds.projectLead,
      ],
    );
    await runMigrations(url);

    const waves = await db
      .select({
        projectId: projectEntryWave.projectId,
        code: projectEntryWave.code,
        name: projectEntryWave.name,
        signingDeadline: projectEntryWave.signingDeadline,
        defaultTgStart: projectEntryWave.defaultTgStart,
        defaultTgEnd: projectEntryWave.defaultTgEnd,
        latestEntryDate: projectEntryWave.latestEntryDate,
      })
      .from(projectEntryWave)
      .orderBy(projectEntryWave.projectId);
    const wave = { code: "W1", name: "W1", latestEntryDate: null };
    expect(waves).toEqual([
      {
        ...wave,
        projectId: seedProjectIds.werkNord,
        signingDeadline: "2027-02-15",
        defaultTgStart: "2027-03-01",
        defaultTgEnd: "2028-02-29",
      },
      {
        ...wave,
        projectId: seedProjectIds.lagerSued,
        signingDeadline: null,
        defaultTgStart: null,
        defaultTgEnd: null,
      },
    ]);
    // The project columns stay until Slice 2 drops them.
    expect(await db.select({ id: project.id }).from(project)).toHaveLength(3);
  });
});
