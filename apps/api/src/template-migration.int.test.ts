import { ManualClock } from "@transfer/adapters";
import { resolveForParticipation } from "@transfer/config";
import { canonicalHash, loadBaseDefaults, loadTemplate } from "@transfer/config/load";
import {
  auditEvent,
  configTemplateVersion,
  createDb,
  eq,
  projectConfigOverride,
  projectTemplatePin,
  seedProjectIds,
  seedStaffUserIds,
  sql,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { ProjectConfig, TemplateMigrationPreview } from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedTemplatePins } from "./projects/seed";
import { loadRelease, projectSnapshot } from "./projects/template-pins";
import { auditContext } from "./sql";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// Slice 2 plan 5.3, 5.4, 5.8, 5.9 and 5.12 (PR 2e-2; Q36, Q93, R15): a pinned template migrates
// to a newer catalog version with the review of its Agentur's scoped setting (AC-16, AC-19,
// AC-20, AC-44, AC-45). Sample templates and synthetic settings only.
const { app, db } = testApp({ clock: new ManualClock(new Date("2026-10-17T10:00:00Z")) });
const urls = testDatabaseUrls();
const owner = createDb(urls.owner);
const holder = createDb(urls.app);
const auth: Record<string, { Cookie: string }> = {};
const release = loadRelease(undefined);
const baseDefaultsVersion = loadBaseDefaults().version;
const { werkNord, lagerSued } = seedProjectIds;
const nord = "beispielstadt-nord";
const sued = "beispielstadt-sued";

const configPath = (projectId: string) => `/api/v1/projects/${projectId}/config`;
const pinPath = (projectId: string, key: string) => `${configPath(projectId)}/pins/${key}`;
const preview = (projectId: string, key: string, body: unknown, user = "projectLead") =>
  app.request(
    `${pinPath(projectId, key)}/migration-preview`,
    jsonRequest("POST", body, auth[user]),
  );
const migrate = (projectId: string, key: string, body: unknown, user = "projectLead") =>
  app.request(`${pinPath(projectId, key)}/migration`, jsonRequest("POST", body, auth[user]));
const config = async (projectId: string, user = "projectLead") =>
  readJson(await app.request(configPath(projectId), { headers: auth[user] }), ProjectConfig);
const codes = async (res: Response, status = 422, type = "domain-error") =>
  (await expectProblem(res, status, type)).errors?.map(({ code, pointer }) => ({ code, pointer }));
const setNordSetting = () =>
  app.request(
    `${configPath(werkNord)}/agentur-settings/${nord}`,
    jsonRequest(
      "PUT",
      {
        expectedVersion: 0,
        settings: { agentur_submission: { leadTimeDays: 12, submissionChannel: "email" } },
        source: "email_agentur",
        confirmedOn: "2026-10-15",
      },
      auth.projectLead,
    ),
  );
const confirm = (extra: object = {}) => ({
  fromVersion: 1,
  version: 2,
  expectedVersion: 1,
  decisions: {
    "agentur_submission.leadTimeDays": "remove",
    "agentur_submission.submissionChannel": "keep",
  },
  ...extra,
});
const eventsOf = (projectId: string) =>
  owner
    .select({ type: auditEvent.eventType, details: auditEvent.details })
    .from(auditEvent)
    .where(eq(auditEvent.projectId, projectId))
    .orderBy(auditEvent.seq);
const overrideVersions = (projectId: string) =>
  owner
    .select({ version: projectConfigOverride.version })
    .from(projectConfigOverride)
    .where(eq(projectConfigOverride.projectId, projectId));

beforeAll(async () => {
  await resetTestDatabase({ seed: true });
  for (const user of Object.keys(seedStaffUserIds) as (keyof typeof seedStaffUserIds)[]) {
    auth[user] = await login(app, seedStaffUserIds[user]);
  }
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true });
  // Werk Nord: beispielstadt-nord@1 (the catalog has 2) and beispielstadt-sued@1.
  await seedTemplatePins(db, release);
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end(), holder.$client.end()]));

describe("GET …/config: what may be migrated (5.8, round 26)", () => {
  it("offers the newer catalog versions per pin to the PL only", async () => {
    const pl = await config(werkNord);
    expect(pl.capabilities.migrateTemplate).toBe(true);
    expect(
      pl.pins.map(({ agenturKey, migrationTargets }) => [agenturKey, migrationTargets]),
    ).toEqual([
      [nord, [2]],
      [sued, []],
    ]);
    for (const user of ["admin", "consultant", "backOffice", "regionalOperationsManager"]) {
      const other = await config(werkNord, user);
      expect(other.capabilities.migrateTemplate).toBe(false);
      expect(other.pins.flatMap(({ migrationTargets }) => migrationTargets)).toEqual([]);
    }
  });
});

describe("POST …/pins/{agenturKey}/migration-preview (AC-19)", () => {
  it("lists what version 2 changes and reviews every key of the Agentur's scoped setting", async () => {
    expect((await setNordSetting()).status).toBe(200);
    const before = await eventsOf(werkNord);
    const res = await preview(werkNord, nord, { version: 2 });
    expect(res.status).toBe(200);
    expect(await readJson(res, TemplateMigrationPreview)).toEqual({
      agenturKey: nord,
      fromVersion: 1,
      version: 2,
      expectedVersion: 1,
      settings: [
        { key: "agentur_submission.leadTimeDays", from: 10, to: 14 },
        { key: "asu_registration.batchSubmissionChannel", from: "scan_email", to: "upload" },
      ],
      rules: {
        added: [
          {
            id: "beispielstadt-nord-mobile",
            step: "data_collection",
            basis: "operational_default",
          },
        ],
        removed: [],
        changed: [],
      },
      fields: { added: [], removed: [], changed: [] },
      overrideIssues: [],
      review: [
        { key: "agentur_submission.leadTimeDays", value: 12, from: 10, to: 14 },
        {
          key: "agentur_submission.submissionChannel",
          value: "email",
          from: "upload",
          to: "upload",
        },
      ],
    });
    // A preview writes nothing.
    expect(await eventsOf(werkNord)).toEqual(before);
  });

  it("refuses a version outside the catalog, the pinned one and another Agentur's pin", async () => {
    expect(await codes(await preview(werkNord, nord, { version: 3 }))).toEqual([
      { code: "template_not_in_catalog", pointer: "/version" },
    ]);
    expect(await codes(await preview(werkNord, nord, { version: 1 }))).toEqual([
      { code: "template_already_pinned", pointer: "/version" },
    ]);
    // An Agentur the project hasn't pinned has no pin to migrate.
    await expectProblem(await preview(lagerSued, nord, { version: 2 }), 404, "not-found");
  });
});

describe("POST …/pins/{agenturKey}/migration (AC-20, AC-45)", () => {
  it("pins the new version and removes the reviewed keys in one transaction, audited with the base-defaults version", async () => {
    await setNordSetting();
    const res = await migrate(werkNord, nord, confirm());
    expect(res.status).toBe(200);
    const after = await readJson(res, ProjectConfig);
    expect(after.pins.map(({ agenturKey, version }) => [agenturKey, version])).toEqual([
      [nord, 2],
      [sued, 1],
    ]);
    expect(after.pins[0]!.migrationTargets).toEqual([]);
    expect(after.override.version).toBe(2);
    expect(after.override.agenturSettings).toEqual([
      expect.objectContaining({
        agenturKey: nord,
        settings: { agentur_submission: { submissionChannel: "email" } },
        confirmedBy: seedStaffUserIds.projectLead,
        confirmedOn: "2026-10-15",
      }),
    ]);
    expect((await eventsOf(werkNord)).slice(-2)).toEqual([
      {
        type: "config_template_pinned",
        details: { agenturKey: nord, version: 2, previousVersion: 1, baseDefaultsVersion },
      },
      {
        type: "config_override_changed",
        details: {
          version: 2,
          change: "agentur_setting_reviewed",
          agenturKey: nord,
          settingKeys: ["agentur_submission.leadTimeDays"],
          keptSettingKeys: ["agentur_submission.submissionChannel"],
          baseDefaultsVersion,
        },
      },
    ]);
  });

  it("resolves the new version for that Agentur only", async () => {
    await setNordSetting();
    await migrate(werkNord, nord, confirm());
    const { input } = (await projectSnapshot(db, release, werkNord))!;
    const provenance = (agenturKey: string) =>
      resolveForParticipation({ ...input, placementAgenturKey: agenturKey }).provenance;
    // The removed key comes from the new template again; the kept one stays the project's.
    expect(provenance(nord)["settings.agentur_submission.leadTimeDays"]).toEqual({
      layer: `template:${nord}@2`,
    });
    expect(provenance(nord)["settings.agentur_submission.submissionChannel"]).toMatchObject({
      layer: `override:agentur:${nord}`,
    });
    expect(provenance(sued)["settings.agentur_submission.leadTimeDays"]).toEqual({
      layer: `template:${sued}@1`,
    });
  });

  it("writes only the pin when every key is kept, or when there is no setting to review", async () => {
    const keepAll = { expectedVersion: 0, decisions: {} };
    expect((await migrate(werkNord, nord, confirm(keepAll))).status).toBe(200);
    expect(await overrideVersions(werkNord)).toEqual([]);
    expect((await eventsOf(werkNord)).at(-1)!.type).toBe("config_template_pinned");
  });

  it("refuses a review that doesn't decide exactly its keys (review_incomplete)", async () => {
    await setNordSetting();
    const missing = { decisions: { "agentur_submission.leadTimeDays": "remove" } };
    const extra = {
      decisions: { ...confirm().decisions, "asu_registration.batchSubmissionChannel": "keep" },
    };
    for (const body of [confirm(missing), confirm(extra)]) {
      expect(await codes(await migrate(werkNord, nord, body))).toEqual([
        { code: "review_incomplete", pointer: "/decisions" },
      ]);
    }
    expect((await config(werkNord)).pins[0]!.version).toBe(1);
  });

  it("refuses a migration that would leave the override invalid, with its issues (AC-16)", async () => {
    // Valid with version 1; version 2 brings a rule of the same id (round 15). Override rules have
    // no API (R13), so the state is inserted as the owner (round 27).
    const rule = { id: "beispielstadt-nord-mobile", kind: "required", field: "mobile" };
    await owner.insert(projectConfigOverride).values({
      projectId: werkNord,
      version: 1,
      content: { schemaVersion: 1, kind: "project_override", rules: { data_collection: [rule] } },
      createdBy: seedStaffUserIds.projectLead,
    });
    const shown = await readJson(
      await preview(werkNord, nord, { version: 2 }),
      TemplateMigrationPreview,
    );
    expect(shown.overrideIssues).toEqual(["rule_redefined"]);
    const res = await migrate(werkNord, nord, confirm({ decisions: {} }));
    expect((await codes(res))?.map(({ code }) => code)).toEqual([
      "override_invalid",
      "rule_redefined",
    ]);
    expect((await config(werkNord)).pins[0]!.version).toBe(1);
  });

  it("is a 409 when the override version moved since the preview", async () => {
    await setNordSetting();
    await expectProblem(
      await migrate(werkNord, nord, confirm({ expectedVersion: 0 })),
      409,
      "conflict",
    );
  });

  // Round 31: the target is checked against the declared fromVersion (422 first), and a pin that
  // moved since the review is a 409, also when it reached the review's target or went beyond it.
  it("checks the target against the declared version before the pin (422, then 409)", async () => {
    const declared = confirm({ fromVersion: 2, expectedVersion: 0, decisions: {} });
    expect(await codes(await migrate(werkNord, nord, declared))).toEqual([
      { code: "template_already_pinned", pointer: "/version" },
    ]);
  });

  const review = confirm({ expectedVersion: 0, decisions: {} });
  /** The review made on version 1 once the pin moved: its status, and whether anything changed. */
  async function staleReview() {
    const before = await eventsOf(werkNord);
    const res = await migrate(werkNord, nord, review);
    return {
      status: res.status,
      written: (await eventsOf(werkNord)).length !== before.length,
      pinned: (await config(werkNord)).pins[0]!.version,
    };
  }

  it("is a 409 when another migration reached the review's target, writing nothing", async () => {
    expect((await migrate(werkNord, nord, review)).status).toBe(200);
    expect(await staleReview()).toEqual({ status: 409, written: false, pinned: 2 });
  });

  it("is a 409 when another migration went beyond the review's target, writing nothing", async () => {
    // A version beyond the catalog's, pinned directly as the owner (a synthetic state).
    const content = { ...loadTemplate(nord, 2), version: 3 };
    await owner.insert(configTemplateVersion).values({
      agenturKey: nord,
      version: 3,
      content,
      contentSha256: canonicalHash(content),
    });
    await owner.insert(projectTemplatePin).values({
      projectId: werkNord,
      agenturKey: nord,
      version: 3,
      pinnedBy: seedStaffUserIds.projectLead,
    });
    expect(await staleReview()).toEqual({ status: 409, written: false, pinned: 3 });
  });

  // Round 31: the preview reads one coherent snapshot. A migration that commits while the preview
  // runs (here: after it read the pins, before it reads the override) is either entirely before
  // or entirely after it, never an old pin with a new override.
  it("previews one coherent state while a migration commits", async () => {
    await setNordSetting();
    let commit!: () => void;
    const gate = new Promise<void>((resolve) => (commit = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    // The owner blocks reads of the override table, then migrates with the review removing the
    // setting (override version 2) and commits.
    const concurrent = owner.transaction(async (tx) => {
      await tx.execute(sql`lock table project_config_override in access exclusive mode`);
      locked();
      await gate;
      const template = loadTemplate(nord, 2);
      await tx.execute(sql`select migrate_agentur_template(p_project_id => ${werkNord}::uuid,
        p_agentur_key => ${nord}, p_from_version => 1, p_version => 2,
        p_content => ${JSON.stringify(template)}::jsonb, p_sha256 => ${canonicalHash(template)},
        p_expected_version => 1,
        p_override_content => ${JSON.stringify({ schemaVersion: 1, kind: "project_override" })}::jsonb,
        p_base_defaults_version => 1,
        p_context => ${auditContext(seedStaffUserIds.projectLead, null)})`);
    });
    await lockTaken;
    const pending = preview(werkNord, nord, { version: 2 });
    // The preview has read the project and the pins and waits to read the override …
    await expect
      .poll(async () => {
        const { rows } = await holder.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_locks where locktype = 'relation' and not granted`,
        );
        return rows[0]!.n;
      })
      .toBe(1);
    commit();
    await concurrent;
    // … and still sees the state before the migration: version 1 pinned, override version 1 with
    // the setting under review (under READ COMMITTED it saw override version 2 without it).
    const shown = await readJson(await pending, TemplateMigrationPreview);
    expect(shown).toMatchObject({ fromVersion: 1, expectedVersion: 1 });
    expect(shown.review.map(({ key }) => key)).toEqual([
      "agentur_submission.leadTimeDays",
      "agentur_submission.submissionChannel",
    ]);
  });

  it("waits for a concurrent override change on the project lock, then refuses the stale review (409)", async () => {
    await setNordSetting();
    let commit!: () => void;
    const gate = new Promise<void>((resolve) => (commit = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    // Another PL's transaction holds the exclusive project lock and removes the setting.
    const concurrent = holder.transaction(async (tx) => {
      await tx.execute(sql`select lock_project_setup(${werkNord}::uuid)`);
      locked();
      await gate;
      await tx.execute(sql`select write_project_override(p_project_id => ${werkNord}::uuid,
        p_expected_version => 1,
        p_content => ${JSON.stringify({ schemaVersion: 1, kind: "project_override" })}::jsonb,
        p_change => 'agentur_setting_removed', p_agentur_key => ${nord},
        p_base_defaults_version => 1,
        p_context => ${auditContext(seedStaffUserIds.projectLead, null)})`);
    });
    await lockTaken;
    const pending = migrate(werkNord, nord, confirm());
    // The request waits on the exclusive project lock (D3) …
    await expect
      .poll(async () => {
        const { rows } = await owner.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`,
        );
        return rows[0]!.n;
      })
      .toBe(1);
    commit();
    await concurrent;
    // … then re-reads the committed state: the review was made on override version 1.
    await expectProblem(await pending, 409, "conflict");
    expect((await config(werkNord)).pins[0]!.version).toBe(1);
  });

  it("checks visibility and the PL's operation before the input's rules (round 28)", async () => {
    const invalid = confirm({ version: 9, decisions: {} });
    for (const user of ["admin", "consultant", "backOffice"]) {
      await expectProblem(await migrate(werkNord, nord, invalid, user), 403, "forbidden");
      await expectProblem(await preview(werkNord, nord, { version: 9 }, user), 403, "forbidden");
    }
    const unknown = "00000000-0000-4000-9000-0000000000ff";
    await expectProblem(await migrate(unknown, nord, invalid), 404, "not-found");
    await expectProblem(await migrate(werkNord, "beispielstadt-ost", confirm()), 404, "not-found");
    // Strict input: the content and hash come from the release, never the client.
    const res = await migrate(werkNord, nord, confirm({ sha256: "0".repeat(64) }));
    expect(await codes(res, 400, "validation-error")).toEqual([
      { code: "unrecognized_keys", pointer: "/sha256" },
    ]);
  });
});
