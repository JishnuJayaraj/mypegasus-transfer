import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrationsFolder, runMigrations } from "./migrate";
import { project, projectEntryWave, projectMembership } from "./schema";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import { testDatabaseUrls } from "./testing";

// AC-20 (Slice 1): migrating a Slice 0 database gives each ta_tg project one wave W1 with its
// dates. AC-3 (Slice 2): projects created after that migration get theirs before the project date
// columns are dropped.
const url = testDatabaseUrls().owner;
const slice0Folder = mkdtempSync(join(tmpdir(), "transfer-slice0-"));
const slice1Folder = mkdtempSync(join(tmpdir(), "transfer-slice1-"));

/** The first `count` migrations: Slice 0 ends after 0001_grants, Slice 1 after 0009_job_run_grants. */
function writeMigrations(folder: string, count: number) {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.slice(0, count);
  mkdirSync(join(folder, "meta"));
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
  for (const { tag } of journal.entries) {
    cpSync(join(migrationsFolder, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
}

const db = createDb(url);
beforeAll(() => {
  writeMigrations(slice0Folder, 2);
  writeMigrations(slice1Folder, 10);
});
afterAll(async () => {
  rmSync(slice0Folder, { recursive: true, force: true });
  rmSync(slice1Folder, { recursive: true, force: true });
  // Leave a fully migrated database for the next test file.
  await db.$client.query("drop owned by transfer_owner");
  await runMigrations(url);
  await db.$client.end();
});

const waveColumns = {
  projectId: projectEntryWave.projectId,
  code: projectEntryWave.code,
  name: projectEntryWave.name,
  signingDeadline: projectEntryWave.signingDeadline,
  defaultTgStart: projectEntryWave.defaultTgStart,
  defaultTgEnd: projectEntryWave.defaultTgEnd,
  latestEntryDate: projectEntryWave.latestEntryDate,
};

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
      .select(waveColumns)
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
    expect(await db.select({ id: project.id }).from(project)).toHaveLength(3);
  });
});

describe("the Slice 1 → Slice 2 migration (AC-3)", () => {
  it("copies the dates of projects created after 0003 into W1, then drops the project date columns", async () => {
    await db.$client.query("drop owned by transfer_owner");
    await runMigrations(url, slice1Folder);
    await db.$client.query(
      "insert into staff_user (id, display_name, email, role) values ($1, 'Petra Projektleitung', 'project-lead@example.org', 'project_lead')",
      [seedStaffUserIds.projectLead],
    );
    // Created with the Slice 0 form during Slice 1: dates on the project only, no wave.
    await db.$client.query(
      `insert into project (id, name, customer_name, type, signing_deadline, default_tg_start, default_tg_end, created_by) values
        ($1, 'Restrukturierung Werk Nord', 'Beispiel Maschinenbau GmbH', 'ta_tg', '2027-02-15', '2027-03-01', '2028-02-29', $3),
        ($2, 'Standortschließung Lager Süd', 'Musterfirma Logistik AG', 'ta_tg', null, null, null, $3)`,
      [seedProjectIds.werkNord, seedProjectIds.lagerSued, seedStaffUserIds.projectLead],
    );
    await runMigrations(url);

    expect(await db.select(waveColumns).from(projectEntryWave)).toEqual([
      {
        projectId: seedProjectIds.werkNord,
        code: "W1",
        name: "W1",
        signingDeadline: "2027-02-15",
        defaultTgStart: "2027-03-01",
        defaultTgEnd: "2028-02-29",
        latestEntryDate: null,
      },
    ]);
    const { rows } = await db.$client.query(
      `select column_name from information_schema.columns where table_name = 'project'
       and column_name in ('signing_deadline', 'default_tg_start', 'default_tg_end')`,
    );
    expect(rows).toEqual([]);
    const statuses = await db.select({ status: project.status }).from(project);
    expect(statuses).toEqual([{ status: "draft" }, { status: "draft" }]);
    // Round 23: each existing project gets its creator as PL member.
    const members = await db
      .select({
        projectId: projectMembership.projectId,
        staffUserId: projectMembership.staffUserId,
      })
      .from(projectMembership)
      .orderBy(projectMembership.projectId);
    expect(members).toEqual([
      { projectId: seedProjectIds.werkNord, staffUserId: seedStaffUserIds.projectLead },
      { projectId: seedProjectIds.lagerSued, staffUserId: seedStaffUserIds.projectLead },
    ]);
  });

  it("fails, changing nothing, when a project would be left without a PL (no silent elevation)", async () => {
    await db.$client.query("drop owned by transfer_owner");
    await runMigrations(url, slice1Folder);
    await db.$client.query(
      "insert into staff_user (id, display_name, email, role) values ($1, 'Bernd Beratung', 'consultant@example.org', 'consultant')",
      [seedStaffUserIds.consultant],
    );
    // A Slice 0 project created by a consultant (the Slice 0 API had no role check).
    await db.$client.query(
      "insert into project (id, name, customer_name, type, created_by) values ($1, 'Transferagentur Verwaltung', 'Fiktiv Versicherungen KG', 'ta_only', $2)",
      [seedProjectIds.verwaltung, seedStaffUserIds.consultant],
    );
    await expect(runMigrations(url)).rejects.toMatchObject({
      cause: { message: "project_without_project_lead" },
    });
    const { rows } = await db.$client.query(
      `select count(*)::int as n from information_schema.tables where table_name = 'project_membership'`,
    );
    expect(rows).toEqual([{ n: 0 }]);
  });
});
