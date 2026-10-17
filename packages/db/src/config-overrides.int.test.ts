import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import { auditContext, call, pl, resetTestDatabase, testDatabaseUrls } from "./testing";

// Slice 2 plan 5.2, 5.3 and 5.9 (PR 2d-1): write_project_override appends the next override
// version under the project lock, or refuses a stale one (AC-14); versions are append-only.
const urls = testDatabaseUrls();
const owner = new Client({ connectionString: urls.owner });
const app = new Client({ connectionString: urls.app });
const other = new Client({ connectionString: urls.app });

beforeAll(() => Promise.all([owner.connect(), app.connect(), other.connect()]));
afterAll(() => Promise.all([owner.end(), app.end(), other.end()]));
beforeEach(() => resetTestDatabase({ seed: true }));

const { werkNord, lagerSued } = seedProjectIds;
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { code: string; message: string }) =>
      error.code === "P0001" ? error.message : error.code,
  );

const setting = (leadTimeDays = 7) => ({
  settings: { agentur_submission: { leadTimeDays, submissionChannel: "upload" } },
  source: "email_agentur",
  confirmedBy: seedStaffUserIds.projectLead,
  confirmedOn: "2026-10-16",
});
const empty = { schemaVersion: 1, kind: "project_override" };
const withSettings = (settings: Record<string, object>) => ({
  ...empty,
  agenturSettings: settings,
});

const write = (
  client: Pick<Client, "query">,
  args: Record<string, unknown> = {},
  projectId: string = werkNord,
) =>
  call<number>(client, "write_project_override", {
    projectId,
    expectedVersion: 0,
    content: withSettings({ "beispielstadt-ost": setting() }),
    change: "agentur_setting_set",
    agenturKey: "beispielstadt-ost",
    baseDefaultsVersion: 1,
    context: pl,
    ...args,
  });

const versionsOf = async (projectId: string) =>
  (
    await owner.query(
      "select version, created_by from project_config_override where project_id = $1 order by version",
      [projectId],
    )
  ).rows;
const auditOf = async (projectId: string) =>
  (
    await owner.query(
      "select actor_staff_user_id, reason_code, details from audit_event where project_id = $1 and event_type = 'config_override_changed' order by seq",
      [projectId],
    )
  ).rows;

describe("write_project_override (5.9, AC-14)", () => {
  it("appends version 1, then the next, each audited with keys, source and the base-defaults version", async () => {
    expect(await write(app)).toBe(1);
    const removed = { ...empty };
    expect(
      await write(app, {
        expectedVersion: 1,
        content: removed,
        change: "agentur_setting_removed",
      }),
    ).toBe(2);
    expect(await versionsOf(werkNord)).toEqual([
      { version: 1, created_by: seedStaffUserIds.projectLead },
      { version: 2, created_by: seedStaffUserIds.projectLead },
    ]);
    const details = {
      change: "agentur_setting_set",
      agenturKey: "beispielstadt-ost",
      settingKeys: ["agentur_submission.leadTimeDays", "agentur_submission.submissionChannel"],
      baseDefaultsVersion: 1,
    };
    expect(await auditOf(werkNord)).toEqual([
      {
        actor_staff_user_id: seedStaffUserIds.projectLead,
        reason_code: null,
        details: { ...details, version: 1, source: "email_agentur" },
      },
      {
        actor_staff_user_id: seedStaffUserIds.projectLead,
        reason_code: null,
        details: { ...details, version: 2, change: "agentur_setting_removed" },
      },
    ]);
    expect(await versionsOf(lagerSued)).toEqual([]);
  });

  it("refuses a stale expected version (override_version_stale)", async () => {
    await write(app);
    expect(await refusal(write(app))).toBe("override_version_stale");
    expect(await refusal(write(app, { expectedVersion: 2 }))).toBe("override_version_stale");
    expect(await versionsOf(werkNord)).toHaveLength(1);
  });

  it("refuses the current content again (override_unchanged), the empty override included", async () => {
    await write(app);
    const again = { expectedVersion: 1 };
    expect(await refusal(write(app, again))).toBe("override_unchanged");
    expect(
      await refusal(write(app, { content: empty, change: "agentur_setting_removed" }, lagerSued)),
    ).toBe("override_unchanged");
  });

  it.each([
    ["content that isn't an override", { content: { ...empty, kind: "regional_template" } }],
    ["no content", { content: null }],
    ["an unknown change", { change: "relaxation_added" }],
    ["a malformed Agentur key", { agenturKey: "Beispielstadt Ost" }],
    ["no base-defaults version", { baseDefaultsVersion: null }],
    ["a negative expected version", { expectedVersion: -1 }],
    ["a set without that Agentur's setting", { agenturKey: "beispielstadt-west" }],
    [
      "a set with an unknown source",
      { content: withSettings({ "beispielstadt-ost": { ...setting(), source: "rumour" } }) },
    ],
    [
      "a set that supplies no setting",
      {
        content: withSettings({
          "beispielstadt-ost": { ...setting(), settings: { agentur_submission: 7 } },
        }),
      },
    ],
    ["a removal of a setting there is none of", { change: "agentur_setting_removed" }],
  ])("refuses %s (invalid_argument)", async (_label, args) => {
    expect(await refusal(write(app, args))).toBe("invalid_argument");
    expect(await versionsOf(werkNord)).toEqual([]);
  });

  it("refuses a removal that keeps the setting (invalid_argument)", async () => {
    await write(app);
    const kept = withSettings({ "beispielstadt-ost": setting(8) });
    expect(
      await refusal(
        write(app, { expectedVersion: 1, content: kept, change: "agentur_setting_removed" }),
      ),
    ).toBe("invalid_argument");
  });

  it.each([
    ["the system", auditContext({ actorType: "system", systemJob: "seed" }), "actor_not_allowed"],
    [
      "assisted mode",
      auditContext({
        actorType: "user",
        staffUserId: seedStaffUserIds.projectLead,
        onBehalfOf: "00000000-0000-4000-a000-000000000001",
      }),
      "invalid_actor",
    ],
  ])("refuses %s", async (_label, context, code) => {
    expect(await refusal(write(app, { context }))).toBe(code);
  });

  it("refuses an unknown project", async () => {
    expect(await refusal(write(app, {}, "00000000-0000-4000-9000-0000000000ff"))).toBe(
      "project_not_found",
    );
  });

  it("serialises two writers of one version on the project lock: the second is stale", async () => {
    await app.query("begin");
    await other.query("begin");
    try {
      await write(app);
      const second = refusal(
        write(other, { content: withSettings({ x: setting() }), agenturKey: "x" }),
      );
      await app.query("commit");
      expect(await second).toBe("override_version_stale");
    } finally {
      await other.query("rollback");
    }
    expect(await versionsOf(werkNord)).toHaveLength(1);
  });

  it("takes the project lock first (D3)", async () => {
    await other.query("begin");
    try {
      await other.query("select lock_project_setup($1)", [werkNord]);
      await app.query("begin");
      await app.query("set local lock_timeout = '300ms'");
      expect(await refusal(write(app))).toBe("55P03");
      await app.query("rollback");
    } finally {
      await other.query("rollback");
    }
  });
});

/** Version 2 of an override whose version 1 exists: a set, or a removal. */
const set = (content: object) => write(app, { expectedVersion: 1, content });
const removal = (content: object) =>
  write(app, { expectedVersion: 1, content, change: "agentur_setting_removed" });

// Round 27: the function's audit event claims one Agentur's setting changed, so nothing else
// may change with it, and a set is confirmed by the acting user (R14).
describe("write_project_override changes exactly the named Agentur's setting", () => {
  const rule = { id: "o-mobile", kind: "required", field: "mobile", basis: "operational_default" };
  const current = {
    ...empty,
    rules: { data_collection: [rule] },
    agenturSettings: { "beispielstadt-nord": setting(), "beispielstadt-ost": setting() },
  };
  // A version with a rule, only possible as the owner (override rules have no API, R13).
  beforeEach(() =>
    owner.query(
      "insert into project_config_override (project_id, version, content, created_by) values ($1, 1, $2, $3)",
      [werkNord, current, seedStaffUserIds.projectLead],
    ),
  );
  const ost = (value: object | undefined, extra: object = {}) => {
    const { "beispielstadt-ost": _, ...others } = current.agenturSettings;
    const agenturSettings = value ? { ...others, "beispielstadt-ost": value } : others;
    return { ...current, agenturSettings, ...extra };
  };

  it("accepts a set and a removal that change only that setting", async () => {
    expect(await refusal(set(ost(setting(8))))).toBe("ok");
    expect(
      await refusal(
        write(app, {
          expectedVersion: 2,
          content: ost(undefined),
          change: "agentur_setting_removed",
        }),
      ),
    ).toBe("ok");
  });

  it.each([
    ["a changed rule", { rules: {} }],
    ["an added field", { fields: { "custom.x": { type: "string", maxLength: 4 } } }],
    ["another Agentur's setting", { agenturSettings: { "beispielstadt-nord": setting(9) } }],
  ])(
    "refuses a set and a removal that also change %s (invalid_argument)",
    async (_label, extra) => {
      const changed = (value: object | undefined) => {
        const content = ost(value, extra);
        if ("agenturSettings" in extra) {
          content.agenturSettings = { ...ost(value).agenturSettings, ...extra.agenturSettings };
        }
        return content;
      };
      expect(await refusal(set(changed(setting(8))))).toBe("invalid_argument");
      expect(await refusal(removal(changed(undefined)))).toBe("invalid_argument");
      expect(await versionsOf(werkNord)).toHaveLength(1);
    },
  );

  it("refuses a set confirmed by another user than the actor (invalid_argument)", async () => {
    const spoofed = { ...setting(8), confirmedBy: seedStaffUserIds.admin };
    expect(await refusal(set(ost(spoofed)))).toBe("invalid_argument");
  });

  it("treats an empty Agentur map as none when the last setting goes", async () => {
    await write(app, {}, lagerSued);
    const remove = (content: object) =>
      write(app, { expectedVersion: 1, content, change: "agentur_setting_removed" }, lagerSued);
    expect(await refusal(remove({ ...empty, agenturSettings: {}, rules: {} }))).toBe(
      "invalid_argument",
    );
    expect(await refusal(remove({ ...empty, agenturSettings: {} }))).toBe("ok");
  });
});

describe("override versions are append-only (5.2)", () => {
  beforeEach(() => write(app));

  it.each([
    "update project_config_override set version = version",
    "delete from project_config_override",
  ])("refuses for the owner too: %s", async (sql) => {
    expect(await refusal(owner.query(sql))).toBe("append_only");
  });

  it.each([
    ["a version below 1", "0", `'${JSON.stringify(empty)}'`],
    ["content that isn't an override", "2", `'{"kind": "base_defaults"}'`],
  ])("checks the row for the owner too: %s (23514)", async (_label, version, content) => {
    const sql = `insert into project_config_override (project_id, version, content, created_by)
      values ('${werkNord}', ${version}, ${content}, '${seedStaffUserIds.projectLead}')`;
    expect(await refusal(owner.query(sql))).toBe("23514");
  });
});
