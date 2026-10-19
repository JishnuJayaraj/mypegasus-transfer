import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import { auditContext, call, pl, resetTestDatabase, testDatabaseUrls } from "./testing";

// Slice 2 plan 5.2, 5.3 and 5.8 (PR 2c-2): pin_agentur_template registers a version on its first
// pin and compares content and hash on every later one (D5, AC-10); the Project Agentur is set
// only to a pinned Agentur (R12).
const urls = testDatabaseUrls();
const owner = new Client({ connectionString: urls.owner });
const app = new Client({ connectionString: urls.app });
const other = new Client({ connectionString: urls.app });

beforeAll(() => Promise.all([owner.connect(), app.connect(), other.connect()]));
afterAll(() => Promise.all([owner.end(), app.end(), other.end()]));
beforeEach(() => resetTestDatabase({ seed: true }));

const { werkNord, lagerSued, verwaltung } = seedProjectIds;
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { code: string; message: string }) =>
      error.code === "P0001" ? error.message : error.code,
  );

/** A synthetic template (the database stores it as given; the service validates it). */
const template = (version = 1, extra: object = {}) => ({
  kind: "regional_template",
  id: "test-agentur",
  agenturKey: "test-agentur",
  version,
  label: { de: "Test" },
  ...extra,
});
const hash = (digit: string) => digit.repeat(64);

const pin = (
  client: Pick<Client, "query">,
  projectId: string,
  args: Record<string, unknown> = {},
) =>
  call(client, "pin_agentur_template", {
    projectId,
    agenturKey: "test-agentur",
    version: 1,
    content: template(),
    sha256: hash("a"),
    baseDefaultsVersion: 1,
    context: pl,
    ...args,
  });

const count = async (table: string) =>
  (await owner.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;

const pinsOf = async (projectId: string) =>
  (
    await owner.query(
      "select agentur_key, version, pinned_by from project_template_pin where project_id = $1 order by seq",
      [projectId],
    )
  ).rows;

const auditOf = async (projectId: string, type: string) =>
  (
    await owner.query(
      "select actor_staff_user_id, details from audit_event where project_id = $1 and event_type = $2 order by seq",
      [projectId, type],
    )
  ).rows;

describe("pin_agentur_template (D5, AC-10)", () => {
  it("registers the version on its first pin, appends the pin and audits it with the base-defaults version", async () => {
    await pin(app, werkNord);
    const { rows } = await owner.query(
      "select agentur_key, version, content, content_sha256 from config_template_version",
    );
    expect(rows).toEqual([
      { agentur_key: "test-agentur", version: 1, content: template(), content_sha256: hash("a") },
    ]);
    expect(await pinsOf(werkNord)).toEqual([
      { agentur_key: "test-agentur", version: 1, pinned_by: seedStaffUserIds.projectLead },
    ]);
    expect(await auditOf(werkNord, "config_template_pinned")).toEqual([
      {
        actor_staff_user_id: seedStaffUserIds.projectLead,
        details: { agenturKey: "test-agentur", version: 1, baseDefaultsVersion: 1 },
      },
    ]);
  });

  it("lets every later pin of the version with the same content and hash share the registered row", async () => {
    await pin(app, werkNord);
    // Key order and formatting don't matter to jsonb equality (the hash is canonical, R22).
    const reordered = Object.fromEntries(Object.entries(template()).toReversed());
    await pin(app, lagerSued, { content: reordered });
    expect(await count("config_template_version")).toBe(1);
    expect(await pinsOf(lagerSued)).toHaveLength(1);
  });

  it.each([
    ["another hash with the same content", { sha256: hash("b") }],
    ["the same claimed hash with other content", { content: template(1, { sample: true }) }],
  ])("refuses %s in any project (template_version_changed)", async (_label, args) => {
    await pin(app, werkNord);
    expect(await refusal(pin(app, lagerSued, args))).toBe("template_version_changed");
    expect(await refusal(pin(app, werkNord, args))).toBe("template_version_changed");
    expect(await pinsOf(lagerSued)).toEqual([]);
    expect(await auditOf(lagerSued, "config_template_pinned")).toEqual([]);
  });

  // PR 2e-2 (R15): another version of a pinned Agentur is a migration with review
  // (migrate_agentur_template), never a plain pin; before 0023 this pin succeeded.
  it("refuses any version of an Agentur the project has pinned already", async () => {
    await pin(app, werkNord);
    for (const version of [1, 2]) {
      const args = { version, content: template(version), sha256: hash(version === 1 ? "a" : "c") };
      expect(await refusal(pin(app, werkNord, args))).toBe("template_already_pinned");
    }
    expect(await pinsOf(werkNord)).toHaveLength(1);
    expect(await auditOf(werkNord, "config_template_pinned")).toHaveLength(1);
  });

  it.each([
    ["content of another key", { content: { ...template(), agenturKey: "other" } }],
    ["content of another version", { content: template(2) }],
    ["content that isn't a template", { content: { ...template(), kind: "project_override" } }],
    ["a malformed key", { agenturKey: "Test Agentur" }],
    ["a malformed hash", { sha256: "A".repeat(64) }],
    ["no base-defaults version", { baseDefaultsVersion: null }],
    ["no content", { content: null }],
  ])("refuses %s (invalid_argument)", async (_label, args) => {
    expect(await refusal(pin(app, werkNord, args))).toBe("invalid_argument");
    expect(await count("config_template_version")).toBe(0);
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
    expect(await refusal(pin(app, werkNord, { context }))).toBe(code);
  });

  it("refuses an unknown project", async () => {
    expect(await refusal(pin(app, "00000000-0000-4000-9000-0000000000ff"))).toBe(
      "project_not_found",
    );
  });

  it("lets exactly one of two concurrent conflicting first pins in two projects succeed", async () => {
    await app.query("begin");
    await other.query("begin");
    try {
      await pin(app, werkNord);
      // Waits on the primary key until the first commits, then compares.
      const second = refusal(pin(other, lagerSued, { content: template(1, { sample: true }) }));
      await app.query("commit");
      expect(await second).toBe("template_version_changed");
    } finally {
      await other.query("rollback");
    }
    expect(await count("config_template_version")).toBe(1);
    expect(await pinsOf(werkNord)).toHaveLength(1);
    expect(await pinsOf(lagerSued)).toEqual([]);
  });

  it("registers the waiting pin's content when the first one rolls back", async () => {
    await app.query("begin");
    await other.query("begin");
    await pin(app, werkNord);
    const second = refusal(pin(other, lagerSued, { content: template(1, { sample: true }) }));
    await app.query("rollback");
    expect(await second).toBe("ok");
    await other.query("commit");
    const { rows } = await owner.query("select content from config_template_version");
    expect(rows).toEqual([{ content: template(1, { sample: true }) }]);
  });

  it("takes the project lock first (D3)", async () => {
    await other.query("begin");
    try {
      await other.query("select lock_project_setup($1)", [werkNord]);
      await app.query("begin");
      await app.query("set local lock_timeout = '300ms'");
      expect(await refusal(pin(app, werkNord))).toBe("55P03");
      await app.query("rollback");
    } finally {
      await other.query("rollback");
    }
  });
});

describe("versions and pins are append-only (AC-10)", () => {
  beforeEach(() => pin(app, werkNord));

  it.each([
    "update config_template_version set content_sha256 = content_sha256",
    "delete from config_template_version",
    "update project_template_pin set version = version",
    "delete from project_template_pin",
  ])("refuses for the owner too: %s", async (sql) => {
    expect(await refusal(owner.query(sql))).toBe("append_only");
  });
});

const setAgentur = (id: string, key = "test-agentur") =>
  call(app, "update_project", { id, context: pl, projectAgenturKey: key });

describe("update_project and the Project Agentur (R12, Q98)", () => {
  it("sets a pinned Agentur and audits its key", async () => {
    await pin(app, werkNord);
    await setAgentur(werkNord);
    const { rows } = await owner.query("select project_agentur_key from project where id = $1", [
      werkNord,
    ]);
    expect(rows).toEqual([{ project_agentur_key: "test-agentur" }]);
    expect((await auditOf(werkNord, "project_changed")).at(-1)!.details).toEqual({
      fields: ["projectAgenturKey"],
      projectAgenturKey: "test-agentur",
    });
    expect(await refusal(setAgentur(werkNord))).toBe("project_unchanged");
  });

  it("refuses an Agentur the project hasn't pinned, even one pinned elsewhere", async () => {
    await pin(app, werkNord);
    expect(await refusal(setAgentur(verwaltung))).toBe("agentur_not_pinned");
  });

  it("refuses a change once the project is active", async () => {
    await pin(app, lagerSued);
    await owner.query(
      "update project set status = 'active', activated_at = now(), activated_by = $2 where id = $1",
      [lagerSued, seedStaffUserIds.projectLead],
    );
    expect(await refusal(setAgentur(lagerSued))).toBe("project_not_draft");
    // A further Agentur may still be pinned (R1).
    await pin(app, lagerSued, {
      agenturKey: "other",
      content: { ...template(), agenturKey: "other" },
    });
  });
});
