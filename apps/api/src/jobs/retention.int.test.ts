import { randomUUID } from "node:crypto";
import { ManualClock, MemoryFileStorage } from "@transfer/adapters";
import {
  createDb,
  retentionPeriods,
  retentionPrerequisites,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { informedParticipation, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { RetentionClass, type RetentionPeriods } from "@transfer/domain";
import { pino } from "pino";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testEnv } from "../testing";
import { parseRetentionArgs, runRetentionCli } from "./cli";
import { runRetention, type RetentionOptions } from "./retention";

// The retention job (ADR-0008, ADR-0011; data-protection.md, retention as built) as the retention
// role. Expected results from the rules, not the code: nothing is deleted while the catalog's
// periods are unset or a prerequisite is unmet; with synthetic periods and a test activation a
// credential goes on day 31, a working copy's file at its trigger, an orphaned object after a day.
const urls = testDatabaseUrls();
const db = createDb(urls.retention);
const app = createDb(urls.app).$client;
const owner = createDb(urls.owner).$client;
afterAll(() => Promise.all([db.$client.end(), app.end(), owner.end()]));

const logs: string[] = [];
const logger = pino(
  { level: "info", base: undefined },
  { write: (line: string) => logs.push(line) },
);

// Synthetic periods and activation: test values, never the DPO's (Q3, Q24).
const synthetic: RetentionPeriods = {
  ...retentionPeriods,
  access_credential: { days: { ended: 30 } },
  form_working_copy: {
    days: { superseded: 30, scan_accepted: 30, abandoned: 90, participation_closed: 30 },
  },
  orphaned_object: { days: { stored: 1 } },
};
const testActivation = {
  periods_confirmed: true,
  hold_administration_confirmed: true,
  evidence_only_access_built: true,
  maintenance_rules_complete: true,
};

let now = new Date("2026-02-01T11:00:00Z");
const storage = new MemoryFileStorage(() => now);
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const key of storage.keys()) await storage.delete(key);
});
const run = (today: string, options: Partial<RetentionOptions> = {}) => {
  now = new Date(`${today}T11:00:00Z`);
  return runRetention(
    { db, storage, clock: new ManualClock(now), logger },
    { periods: synthetic, prerequisites: testActivation, dryRun: false, today, ...options },
  );
};
const count = async (sql: string, values: unknown[] = []) =>
  Number((await owner.query(`select count(*) as n from ${sql}`, values)).rows[0].n);

/** A staff session that ended at noon of `endedOn` (Berlin). */
async function endedSession(endedOn: string): Promise<string> {
  const hash = randomUUID().replaceAll("-", "").padEnd(64, "0");
  await owner.query(
    `insert into staff_session (token_hash, staff_user_id, created_at, expires_at, ended_at, end_reason)
     values ($1, $2, $3::timestamptz - interval '1 hour', $3::timestamptz + interval '7 hours', $3, 'logout')`,
    [hash, seedStaffUserIds.consultant, `${endedOn}T11:00:00Z`],
  );
  return hash;
}

/** A generated TL 407 working copy of a new participation, its object in the store. */
async function workingCopy(generatedAt: string): Promise<string> {
  const participation = await informedParticipation(app);
  const id = randomUUID();
  await owner.query(
    `insert into document (id, project_id, participation_id, type, catalog_version, retention_class,
       media_type, size_bytes, content_sha256, file_name, key_id, wrapped_key, added_by,
       added_by_staff_user_id, added_on_behalf, added_at)
     values ($1, $2, $3, 'tl407_form', 10, 'form_working_copy', 'application/pdf', 100, repeat('a', 64),
       'tl407.pdf', repeat('b', 16), decode(repeat('00', 60), 'hex'), 'user', $4, false, $5)`,
    [id, seedProjectIds.werkNord, participation, seedStaffUserIds.projectLead, generatedAt],
  );
  await owner.query(
    `insert into form_generation (id, project_id, participation_id, document_id, form_code, form_version,
       profile_revision, profiling_revision, assessment_revision, unemployment_revision, source_token,
       organisation_sha256, confirmed_warnings, anlage, generated_by, generated_at)
     values (gen_random_uuid(), $1, $2, $3, 'tl407', '01-2026', 0, 0, 0, 0, repeat('c', 64), repeat('d', 64),
       '{}', false, $4, $5)`,
    [seedProjectIds.werkNord, participation, id, seedStaffUserIds.projectLead, generatedAt],
  );
  await storage.put(`documents/${id}`, new Uint8Array([1]));
  return id;
}

describe("with the catalog or activation off", () => {
  it("deletes nothing and reports every class, the catalog's periods unset", async () => {
    const session = await endedSession("2025-01-01");
    const copy = await workingCopy("2025-01-01T10:00:00Z");
    const summary = await run("2026-02-01", {
      periods: retentionPeriods,
      prerequisites: retentionPrerequisites,
    });
    expect(summary.dryRun).toBe(true);
    expect(summary.unmet).toHaveLength(4);
    expect(Object.keys(summary.classes)).toEqual(RetentionClass.options);
    for (const c of RetentionClass.options) {
      expect(summary.classes[c]).toMatchObject({
        outcome: c === "reference_data" ? "never" : "period_unset",
        due: 0,
        deleted: 0,
      });
    }
    expect(await count("staff_session where token_hash = $1", [session])).toBe(1);
    expect(await storage.get(`documents/${copy}`)).toEqual(new Uint8Array([1]));
  });

  it("with synthetic periods but a prerequisite unmet, counts what is due and deletes nothing", async () => {
    const session = await endedSession("2025-01-01");
    const copy = await workingCopy("2025-01-01T10:00:00Z");
    await storage.put(`documents/${randomUUID()}`, new Uint8Array([2]));
    now = new Date("2026-01-01T00:00:00Z");
    const summary = await run("2026-02-01", {
      prerequisites: { ...testActivation, evidence_only_access_built: false },
    });
    expect(summary).toMatchObject({ dryRun: true, unmet: ["evidence_only_access_built"] });
    expect(summary.classes.access_credential).toMatchObject({
      outcome: "counted",
      due: 1,
      deleted: 0,
    });
    expect(summary.classes.form_working_copy).toMatchObject({
      outcome: "counted",
      due: 1,
      deleted: 0,
    });
    expect(summary.classes.personnel_file).toMatchObject({
      outcome: "period_unset",
      due: 0,
      deleted: 0,
    });
    expect(await count("staff_session where token_hash = $1", [session])).toBe(1);
    expect(await count("document where id = $1 and deleted_at is null", [copy])).toBe(1);
    expect((await storage.list("documents")).length).toBeGreaterThanOrEqual(2);
    // A dry run by request too, whatever the activation.
    expect((await run("2026-02-01", { dryRun: true })).dryRun).toBe(true);
    expect(await count("staff_session where token_hash = $1", [session])).toBe(1);
  });
});

describe("with synthetic periods and test activation", () => {
  it("strips an access credential on day 31, not day 30", async () => {
    const session = await endedSession("2026-01-01");
    const live = await endedSession("2026-01-20");
    const day30 = await run("2026-01-31");
    expect(day30.classes.access_credential).toMatchObject({
      outcome: "applied",
      due: 0,
      deleted: 0,
    });
    expect(await count("staff_session where token_hash = $1", [session])).toBe(1);
    const day31 = await run("2026-02-01");
    expect(day31.classes.access_credential).toMatchObject({
      outcome: "applied",
      due: 1,
      deleted: 1,
    });
    expect(await count("staff_session where token_hash = $1", [session])).toBe(0);
    expect(await count("staff_session where token_hash = $1", [live])).toBe(1);
    // Idempotent: the next run finds nothing more.
    expect((await run("2026-02-01")).classes.access_credential.deleted).toBe(0);
  });

  it("purges an abandoned working copy's file at its trigger and keeps the row as the tombstone", async () => {
    const copy = await workingCopy("2025-10-01T10:00:00Z");
    // Kept for 90 days after its generation: day 90 keeps it, day 91 purges it.
    await run("2025-12-30");
    expect(await storage.get(`documents/${copy}`)).toEqual(new Uint8Array([1]));
    const summary = await run("2025-12-31");
    expect(summary.classes.form_working_copy).toMatchObject({
      outcome: "applied",
      due: 1,
      deleted: 1,
    });
    expect(await storage.list("documents")).toEqual([]);
    const { rows } = await owner.query(
      `select deleted_by, file_name, purged_at is not null as purged, delete_reason
       from document where id = $1`,
      [copy],
    );
    expect(rows).toEqual([
      { deleted_by: "system", file_name: null, purged: true, delete_reason: null },
    ]);
    expect(await count("form_generation where document_id = $1", [copy])).toBe(1);
  });

  it("purges an orphaned object a day after it was written, never a document's own", async () => {
    const copy = await workingCopy("2026-01-30T10:00:00Z");
    const orphan = `documents/${randomUUID()}`;
    now = new Date("2026-01-30T11:00:00Z");
    await storage.put(orphan, new Uint8Array([3]));
    const fresh = `documents/${randomUUID()}`;
    now = new Date("2026-02-01T10:00:00Z");
    await storage.put(fresh, new Uint8Array([4]));
    const summary = await run("2026-02-01");
    expect(summary.classes.orphaned_object).toMatchObject({
      outcome: "applied",
      due: 1,
      deleted: 1,
    });
    expect((await storage.list("documents")).map((o) => o.key).toSorted()).toEqual(
      [`documents/${copy}`, fresh].toSorted(),
    );
  });

  it("records the run without a subject and logs counts only", async () => {
    const session = await endedSession("2025-01-01");
    logs.length = 0;
    await run("2026-02-01");
    const { rows } = await owner.query("select run_day::text, dry_run, summary from retention_run");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].summary)).not.toContain(session);
    expect(rows[0]).toMatchObject({ run_day: "2026-02-01", dry_run: false });
    expect(logs.join("")).not.toContain(session);
  });

  it("refuses a day the database hasn't reached", async () => {
    await expect(run("2099-01-01")).rejects.toMatchObject({ code: "run_not_due" });
  });
});

describe("pnpm jobs:retention", () => {
  it("takes --dry-run and --today, nothing else", () => {
    expect(parseRetentionArgs([])).toEqual({ dryRun: false });
    expect(parseRetentionArgs(["--dry-run", "--today=2026-02-01"])).toEqual({
      dryRun: true,
      today: "2026-02-01",
    });
    expect(parseRetentionArgs(["--today", "2026-02-01"])).toEqual({
      dryRun: false,
      today: "2026-02-01",
    });
    for (const argv of [
      ["--today"],
      ["--today", "01.02.2026"],
      ["--now"],
      ["--dry-run", "--dry-run"],
    ]) {
      expect(() => parseRetentionArgs(argv)).toThrow(
        expect.objectContaining({ code: "invalid_arguments" }),
      );
    }
  });

  it("runs with the catalog only: a dry run that lists every class period_unset", async () => {
    const summary = await runRetentionCli({
      argv: ["--today", "2026-02-01"],
      env: testEnv,
      db,
      storage,
      logger,
    });
    expect(summary.dryRun).toBe(true);
    expect(Object.values(summary.classes).filter((c) => c.outcome === "period_unset")).toHaveLength(
      RetentionClass.options.length - 1,
    );
  });

  it("refuses --today in production", async () => {
    await expect(
      runRetentionCli({
        argv: ["--today", "2026-02-01"],
        env: { ...testEnv, nodeEnv: "production" },
        db,
        storage,
        logger,
      }),
    ).rejects.toMatchObject({ code: "refused_in_production" });
  });
});
