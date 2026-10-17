import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import { call, pl, resetTestDatabase, testDatabaseUrls } from "./testing";

// Slice 2 plan 5.3, 5.8 and 5.9 (PR 2e-2; Q36, Q93, R15): migrate_agentur_template moves a pinned
// Agentur to a newer version and, when the review removes keys of its scoped setting, appends the
// override version in the same call (AC-20). Synthetic templates and settings only.
const urls = testDatabaseUrls();
const owner = new Client({ connectionString: urls.owner });
const app = new Client({ connectionString: urls.app });
const other = new Client({ connectionString: urls.app });

beforeAll(() => Promise.all([owner.connect(), app.connect(), other.connect()]));
afterAll(() => Promise.all([owner.end(), app.end(), other.end()]));
beforeEach(async () => {
  await resetTestDatabase({ seed: true });
  await pin(1);
});

const { werkNord } = seedProjectIds;
const key = "test-agentur";
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { code: string; message: string }) =>
      error.code === "P0001" ? error.message : error.code,
  );

const template = (version: number) => ({
  kind: "regional_template",
  id: key,
  agenturKey: key,
  version,
  label: { de: "Test" },
});
const hash = (version: number) => String(version).repeat(64);
const pin = (version: number) =>
  call(app, "pin_agentur_template", {
    projectId: werkNord,
    agenturKey: key,
    version,
    content: template(version),
    sha256: hash(version),
    baseDefaultsVersion: 1,
    context: pl,
  });

const migrate = (args: Record<string, unknown> = {}, client: Pick<Client, "query"> = app) =>
  call<number>(client, "migrate_agentur_template", {
    projectId: werkNord,
    agenturKey: key,
    fromVersion: 1,
    version: 2,
    content: template(2),
    sha256: hash(2),
    expectedVersion: 0,
    overrideContent: null,
    baseDefaultsVersion: 1,
    context: pl,
    ...args,
  });

const setting = (settings: object) => ({
  settings,
  source: "email_agentur",
  confirmedBy: seedStaffUserIds.projectLead,
  confirmedOn: "2026-10-16",
});
const scoped = {
  agentur_submission: { leadTimeDays: 7, submissionChannel: "upload" },
  asu_registration: { batchSubmissionChannel: "paper_post" },
};
const override = (agenturSettings: Record<string, object>, extra: object = {}) => ({
  schemaVersion: 1,
  kind: "project_override",
  agenturSettings,
  ...extra,
});
const current = override({ [key]: setting(scoped), "beispielstadt-ost": setting(scoped) });
/** Version 1 of the override with two scoped settings (a synthetic state, inserted as the owner). */
const withSetting = () =>
  owner.query(
    "insert into project_config_override (project_id, version, content, created_by) values ($1, 1, $2, $3)",
    [werkNord, current, seedStaffUserIds.projectLead],
  );
/** The override with this Agentur's setting reduced to `settings` (null: removed). */
const reviewed = (settings: object | null) => {
  const { [key]: _, ...others } = current.agenturSettings;
  return override(settings ? { ...others, [key]: setting(settings) } : others);
};

const pinsOf = async () =>
  (
    await owner.query(
      "select version from project_template_pin where project_id = $1 and agentur_key = $2 order by seq",
      [werkNord, key],
    )
  ).rows.map((row: { version: number }) => row.version);
const auditOf = async (type: string) =>
  (
    await owner.query(
      "select details from audit_event where project_id = $1 and event_type = $2 order by seq",
      [werkNord, type],
    )
  ).rows.map((row: { details: object }) => row.details);
const overrideVersions = async () =>
  (
    await owner.query(
      "select version, content from project_config_override where project_id = $1 order by version",
      [werkNord],
    )
  ).rows;

describe("migrate_agentur_template (5.8, AC-20)", () => {
  it("pins the newer version with the replaced one, and writes no override without removals", async () => {
    expect(await migrate()).toBe(0);
    expect(await pinsOf()).toEqual([1, 2]);
    expect((await auditOf("config_template_pinned")).at(-1)).toEqual({
      agenturKey: key,
      version: 2,
      previousVersion: 1,
      baseDefaultsVersion: 1,
    });
    expect(await auditOf("config_override_changed")).toEqual([]);
  });

  it("removes the reviewed keys as the next override version, audited with removed and kept keys", async () => {
    await withSetting();
    const content = reviewed({ agentur_submission: { submissionChannel: "upload" } });
    expect(await migrate({ expectedVersion: 1, overrideContent: content })).toBe(2);
    expect((await overrideVersions()).at(-1)).toEqual({ version: 2, content });
    expect((await auditOf("config_override_changed")).at(-1)).toEqual({
      version: 2,
      change: "agentur_setting_reviewed",
      agenturKey: key,
      settingKeys: ["agentur_submission.leadTimeDays", "asu_registration.batchSubmissionChannel"],
      keptSettingKeys: ["agentur_submission.submissionChannel"],
      baseDefaultsVersion: 1,
    });
    // The pin comes first in the same call (one transaction with the override version).
    const types = await owner.query(
      "select event_type from audit_event where project_id = $1 order by seq desc limit 2",
      [werkNord],
    );
    expect(types.rows.map((row: { event_type: string }) => row.event_type)).toEqual([
      "config_override_changed",
      "config_template_pinned",
    ]);
  });

  it("removes the whole setting with its last key", async () => {
    await withSetting();
    expect(await migrate({ expectedVersion: 1, overrideContent: reviewed(null) })).toBe(2);
    const [event] = (await auditOf("config_override_changed")).slice(-1);
    expect(event).toEqual({
      version: 2,
      change: "agentur_setting_reviewed",
      agenturKey: key,
      settingKeys: [
        "agentur_submission.leadTimeDays",
        "agentur_submission.submissionChannel",
        "asu_registration.batchSubmissionChannel",
      ],
      baseDefaultsVersion: 1,
    });
  });

  it.each([
    [
      "an Agentur the project hasn't pinned",
      {
        agenturKey: "other-agentur",
        content: { ...template(2), id: "other-agentur", agenturKey: "other-agentur" },
      },
      "agentur_not_pinned",
    ],
    [
      "the pinned version",
      { version: 1, content: template(1), sha256: hash(1) },
      "template_already_pinned",
    ],
    [
      "a review of another pinned version",
      { fromVersion: 3, version: 4, content: template(4), sha256: hash(4) },
      "pin_version_stale",
    ],
    ["a stale override version", { expectedVersion: 1 }, "override_version_stale"],
    ["no pinned version", { fromVersion: null }, "invalid_argument"],
  ])("refuses %s, writing nothing", async (_label, args, code) => {
    expect(await refusal(migrate(args))).toBe(code);
    expect(await pinsOf()).toEqual([1]);
    expect(await auditOf("config_template_pinned")).toHaveLength(1);
  });

  it("refuses an older version (template_version_not_newer)", async () => {
    await migrate();
    const older = { fromVersion: 2, version: 1, content: template(1), sha256: hash(1) };
    expect(await refusal(migrate(older))).toBe("template_version_not_newer");
    expect(await pinsOf()).toEqual([1, 2]);
  });

  it("compares content and hash with a version registered by another project (D5)", async () => {
    await call(app, "pin_agentur_template", {
      projectId: seedProjectIds.lagerSued,
      agenturKey: key,
      version: 2,
      content: template(2),
      sha256: hash(2),
      baseDefaultsVersion: 1,
      context: pl,
    });
    expect(await refusal(migrate({ sha256: hash(5) }))).toBe("template_version_changed");
    expect(await refusal(migrate())).toBe("ok");
  });

  it("refuses a stale review after a concurrent migration on the project lock", async () => {
    await app.query("begin");
    await other.query("begin");
    try {
      await migrate();
      const second = refusal(migrate({ version: 3, content: template(3), sha256: hash(3) }, other));
      await app.query("commit");
      expect(await second).toBe("pin_version_stale");
    } finally {
      await other.query("rollback");
    }
    expect(await pinsOf()).toEqual([1, 2]);
  });

  it("takes the project lock first (D3)", async () => {
    await other.query("begin");
    try {
      await other.query("select lock_project_setup($1)", [werkNord]);
      await app.query("begin");
      await app.query("set local lock_timeout = '300ms'");
      expect(await refusal(migrate())).toBe("55P03");
      await app.query("rollback");
    } finally {
      await other.query("rollback");
    }
  });
});

/** A refused review leaves the pin and the override as they were. */
const rejected = async (content: object) => ({
  refusal: await refusal(migrate({ expectedVersion: 1, overrideContent: content })),
  pins: await pinsOf(),
  overrideVersions: (await overrideVersions()).length,
});
const unchanged = { refusal: "invalid_argument", pins: [1], overrideVersions: 1 };

// Round 27: the event claims that the review removed keys of this Agentur's setting, so the
// content may differ from the current one in exactly that.
describe("migrate_agentur_template changes exactly the reviewed setting", () => {
  beforeEach(withSetting);

  it.each([
    ["nothing removed", reviewed(scoped)],
    ["a changed value", reviewed({ agentur_submission: { leadTimeDays: 8 } })],
    ["an added key", reviewed({ agentur_submission: { originalRequired: true } })],
    ["an empty setting", reviewed({})],
  ])("refuses %s (invalid_argument)", async (_label, content) => {
    expect(await rejected(content)).toEqual(unchanged);
  });

  it("refuses another source or confirmation, or another part of the override", async () => {
    const kept = { agentur_submission: { submissionChannel: "upload" } };
    const base = reviewed(kept);
    const [otherSource, otherConfirmer] = [
      { source: "letter_agentur" },
      { confirmedBy: seedStaffUserIds.admin },
    ].map((change) =>
      override({ ...base.agenturSettings, [key]: { ...setting(kept), ...change } }),
    );
    expect(await rejected(otherSource!)).toEqual(unchanged);
    expect(await rejected(otherConfirmer!)).toEqual(unchanged);
    expect(
      await rejected({ ...base, fields: { "custom.x": { type: "string", maxLength: 4 } } }),
    ).toEqual(unchanged);
    expect(await rejected(override({ [key]: setting(kept) }))).toEqual(unchanged);
    expect(await rejected({ ...base, kind: "regional_template" })).toEqual(unchanged);
  });
});

it("refuses a review of an Agentur without a setting (invalid_argument)", async () => {
  const content = override({ "beispielstadt-ost": setting(scoped) });
  expect(await refusal(migrate({ overrideContent: content }))).toBe("invalid_argument");
});

// Round 28: what must only happen inside a migration has no other way in.
describe("a template version changes only through the migration", () => {
  it("refuses the review's change kind in the granted override write", async () => {
    await withSetting();
    const content = reviewed({ agentur_submission: { submissionChannel: "upload" } });
    const write = call(app, "write_project_override", {
      projectId: werkNord,
      expectedVersion: 1,
      content,
      change: "agentur_setting_reviewed",
      agenturKey: key,
      baseDefaultsVersion: 1,
      context: pl,
    });
    expect(await refusal(write)).toBe("invalid_argument");
  });

  it("gives the app no access to the internal helpers", async () => {
    const helper = app.query("select append_template_pin($1, $2, 2, $3, $4, 1, null, 1)", [
      werkNord,
      key,
      template(2),
      hash(2),
    ]);
    expect(await refusal(helper)).toBe("42501");
    expect(await refusal(app.query("select scoped_setting_keys('{}')"))).toBe("42501");
  });
});
