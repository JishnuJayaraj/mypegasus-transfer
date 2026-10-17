import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  auditContext,
  call,
  pl,
  resetTestDatabase,
  reviewer,
  testDatabaseUrls,
  textDates,
} from "./testing";

// Slice 2 plan 5.2, 5.3 and 5.9 (PR 2d-2): rule relaxations with approval (Q75, round 8, R2;
// AC-15). The role checks are the service's; these test structure, progress and four eyes.
const urls = testDatabaseUrls();
const owner = new Client({ connectionString: urls.owner, types: textDates });
const app = new Client({ connectionString: urls.app, types: textDates });

beforeAll(() => Promise.all([owner.connect(), app.connect()]));
afterAll(() => Promise.all([owner.end(), app.end()]));
beforeEach(() => resetTestDatabase({ seed: true }));

const { werkNord, lagerSued } = seedProjectIds;
const ruleId = "base-import-birthDate";
const empty = { schemaVersion: 1, kind: "project_override" };
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { code: string; message: string }) =>
      error.code === "P0001" ? error.message : error.code,
  );

const request = (args: Record<string, unknown> = {}, client: Client = app) =>
  call(client, "request_rule_relaxation", {
    projectId: werkNord,
    ruleId,
    reasonCode: "source_data_not_provided",
    requestedOn: "2026-10-17",
    baseDefaultsVersion: 1,
    context: pl,
    ...args,
  });

/** The approved relaxation as the approval must store it. */
const entry = (extra: object = {}) => ({
  ruleId,
  reasonCode: "source_data_not_provided",
  approvedBy: seedStaffUserIds.admin,
  approvedOn: "2026-10-18",
  ...extra,
});
const approve = (requestId: string, args: Record<string, unknown> = {}) =>
  call(app, "decide_rule_relaxation", {
    requestId,
    approve: true,
    decidedOn: "2026-10-18",
    context: reviewer,
    expectedVersion: 0,
    content: { ...empty, relax: [entry()] },
    baseDefaultsVersion: 1,
    ...args,
  });
const reject = (requestId: string, args: Record<string, unknown> = {}) =>
  call(app, "decide_rule_relaxation", {
    requestId,
    approve: false,
    decidedOn: "2026-10-18",
    context: reviewer,
    ...args,
  });

const requests = async () =>
  (
    await owner.query(
      "select rule_id, reason_code, status, requested_by, requested_on, decided_by, decided_on, decided_at is not null as decided from config_relaxation_request order by requested_at",
    )
  ).rows;
const overrides = async (projectId = werkNord) =>
  (
    await owner.query(
      "select version, content from project_config_override where project_id = $1 order by version",
      [projectId],
    )
  ).rows;
const audit = async () =>
  (
    await owner.query(
      "select event_type, actor_staff_user_id, reason_code, details from audit_event where event_type::text like 'rule_relaxation_%' or event_type = 'config_override_changed' order by seq",
    )
  ).rows;

describe("request_rule_relaxation (5.9 step 1)", () => {
  it("records a pending request, audited with its reason code and the base-defaults version (R26)", async () => {
    const id = await request();
    expect(await requests()).toEqual([
      {
        rule_id: ruleId,
        reason_code: "source_data_not_provided",
        status: "requested",
        requested_by: seedStaffUserIds.projectLead,
        requested_on: "2026-10-17",
        decided_by: null,
        decided_on: null,
        decided: false,
      },
    ]);
    expect(await audit()).toEqual([
      {
        event_type: "rule_relaxation_requested",
        actor_staff_user_id: seedStaffUserIds.projectLead,
        reason_code: "source_data_not_provided",
        details: { relaxationRequestId: id, ruleId, baseDefaultsVersion: 1 },
      },
    ]);
    expect(await overrides()).toEqual([]);
  });

  it("allows one open request per project and rule (relaxation_request_open), in SQL and in the table", async () => {
    await request();
    expect(await refusal(request({ reasonCode: "collected_outside_platform" }))).toBe(
      "relaxation_request_open",
    );
    expect(await refusal(request({}, owner))).toBe("relaxation_request_open");
    const direct = `insert into config_relaxation_request (project_id, rule_id, reason_code, status, requested_by, requested_on)
      values ($1, $2, 'source_data_not_provided', 'requested', $3, '2026-10-17')`;
    expect(await refusal(owner.query(direct, [werkNord, ruleId, seedStaffUserIds.admin]))).toBe(
      "23505",
    );
    // Another rule, or the same rule in another project, is a request of its own.
    expect(await refusal(request({ ruleId: "base-import-address" }))).toBe("ok");
    expect(await refusal(request({ projectId: lagerSued }))).toBe("ok");
  });

  it("refuses a rule the current override relaxes already (relaxation_exists)", async () => {
    await approve(await request());
    expect(await refusal(request())).toBe("relaxation_exists");
  });

  it.each([
    ["a rule id that isn't an id", { ruleId: "Regel für Frau M." }],
    ["no reason code", { reasonCode: null }],
    ["no request date", { requestedOn: null }],
    ["no base-defaults version", { baseDefaultsVersion: null }],
  ])("refuses %s (invalid_argument)", async (_label, args) => {
    expect(await refusal(request(args))).toBe("invalid_argument");
  });

  it("refuses a reason code outside the controlled list (22P02)", async () => {
    expect(await refusal(request({ reasonCode: "too_much_work" }))).toBe("22P02");
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
    expect(await refusal(request({ context }))).toBe(code);
  });

  it("refuses an unknown project", async () => {
    expect(await refusal(request({ projectId: "00000000-0000-4000-9000-0000000000ff" }))).toBe(
      "project_not_found",
    );
  });

  it("takes the project lock first (D3)", async () => {
    await owner.query("begin");
    try {
      await owner.query("select lock_project_setup($1)", [werkNord]);
      await app.query("begin");
      await app.query("set local lock_timeout = '300ms'");
      expect(await refusal(request())).toBe("55P03");
      await app.query("rollback");
    } finally {
      await owner.query("rollback");
    }
  });
});

describe("decide_rule_relaxation (5.9 step 3, R2, AC-15)", () => {
  let id: string;
  beforeEach(async () => {
    id = await request();
  });

  it("an approval by another person adds the relaxation as the next override version, audited", async () => {
    await approve(id);
    expect(await requests()).toMatchObject([
      { status: "approved", decided_by: seedStaffUserIds.admin, decided_on: "2026-10-18" },
    ]);
    expect(await overrides()).toEqual([{ version: 1, content: { ...empty, relax: [entry()] } }]);
    expect((await audit()).slice(1)).toEqual([
      {
        event_type: "config_override_changed",
        actor_staff_user_id: seedStaffUserIds.admin,
        reason_code: null,
        details: { version: 1, change: "relaxation_added", ruleId, baseDefaultsVersion: 1 },
      },
      {
        event_type: "rule_relaxation_approved",
        actor_staff_user_id: seedStaffUserIds.admin,
        reason_code: "source_data_not_provided",
        details: { relaxationRequestId: id, ruleId, version: 1, baseDefaultsVersion: 1 },
      },
    ]);
  });

  it("a rejection decides without changing the configuration, audited", async () => {
    await reject(id);
    expect(await requests()).toMatchObject([
      { status: "rejected", decided_by: seedStaffUserIds.admin, decided: true },
    ]);
    expect(await overrides()).toEqual([]);
    expect((await audit()).slice(1)).toEqual([
      {
        event_type: "rule_relaxation_rejected",
        actor_staff_user_id: seedStaffUserIds.admin,
        reason_code: null,
        details: { relaxationRequestId: id, ruleId },
      },
    ]);
  });

  it("never lets the requester decide (four eyes, in the function and in the table)", async () => {
    expect(
      await refusal(
        approve(id, {
          context: pl,
          content: { ...empty, relax: [entry({ approvedBy: seedStaffUserIds.projectLead })] },
        }),
      ),
    ).toBe("same_person_approval");
    expect(await refusal(reject(id, { context: pl }))).toBe("same_person_approval");
    const direct = `update config_relaxation_request set status = 'rejected', decided_by = requested_by,
      decided_on = '2026-10-18', decided_at = now()`;
    expect(await refusal(owner.query(direct))).toBe("23514");
    expect(await requests()).toMatchObject([{ status: "requested" }]);
  });

  it("decides only a pending request, once (relaxation_not_open)", async () => {
    await reject(id);
    expect(await refusal(approve(id))).toBe("relaxation_not_open");
    expect(await refusal(reject(id))).toBe("relaxation_not_open");
    expect(await refusal(reject("00000000-0000-4000-b000-0000000000ff"))).toBe("request_not_found");
  });

  it.each([
    [
      "another reason code",
      { content: { ...empty, relax: [entry({ reasonCode: "collected_outside_platform" })] } },
    ],
    [
      "another approver",
      { content: { ...empty, relax: [entry({ approvedBy: seedStaffUserIds.projectLead })] } },
    ],
    [
      "another approval date",
      { content: { ...empty, relax: [entry({ approvedOn: "2026-10-17" })] } },
    ],
    ["no relaxation", { content: { ...empty, relax: [] } }],
    ["the relaxation twice", { content: { ...empty, relax: [entry(), entry()] } }],
    [
      "another change too",
      { content: { ...empty, relax: [entry(), { ...entry(), ruleId: "base-import-address" }] } },
    ],
    ["an added rule", { content: { ...empty, relax: [entry()], rules: { data_collection: [] } } }],
    ["no override content", { content: null }],
    ["no base-defaults version", { baseDefaultsVersion: null }],
  ])("refuses an approval with %s, deciding nothing (invalid_argument)", async (_label, args) => {
    expect(await refusal(approve(id, args))).toBe("invalid_argument");
    expect(await requests()).toMatchObject([{ status: "requested", decided: false }]);
    expect(await overrides()).toEqual([]);
  });

  it("refuses an approval against a stale override version (override_version_stale)", async () => {
    expect(await refusal(approve(id, { expectedVersion: 1 }))).toBe("override_version_stale");
    expect(await requests()).toMatchObject([{ status: "requested" }]);
  });

  it("refuses override arguments with a rejection (invalid_argument)", async () => {
    expect(await refusal(reject(id, { expectedVersion: 0 }))).toBe("invalid_argument");
    expect(await refusal(reject(id, { approve: null }))).toBe("invalid_argument");
  });

  it("keeps the record moving forward only, for the owner too (request_immutable)", async () => {
    await reject(id);
    for (const sql of [
      "update config_relaxation_request set status = 'withdrawn', decided_by = null, decided_on = null, decided_at = null",
      "update config_relaxation_request set reason_code = 'collected_outside_platform'",
      "update config_relaxation_request set status = status",
    ]) {
      expect(await refusal(owner.query(sql))).toBe("request_immutable");
    }
  });
});

/** A relaxation change through write_project_override directly (by default, a removal). */
const write = (args: Record<string, unknown>) =>
  call(app, "write_project_override", {
    projectId: werkNord,
    expectedVersion: 1,
    change: "relaxation_removed",
    agenturKey: null,
    ruleId,
    baseDefaultsVersion: 1,
    context: pl,
    ...args,
  });

describe("write_project_override and relaxations (round 27's exact delta)", () => {
  // Round 28: never inferred from a timestamp. A committed approval stamped with this
  // transaction's now(), by this actor, for this rule, doesn't let the granted function add it.
  it("never adds a relaxation directly, even with an approval stamped with this transaction's time", async () => {
    await app.query("begin");
    try {
      // As text: a JS Date would drop the microseconds and miss the timestamp.
      const { rows } = await app.query("select now()::text as now");
      await owner.query(
        `insert into config_relaxation_request (project_id, rule_id, reason_code, status,
           requested_by, requested_on, decided_by, decided_on, decided_at)
         values ($1, $2, 'source_data_not_provided', 'approved', $3, '2026-10-17', $4,
           '2026-10-18', $5::timestamptz)`,
        [werkNord, ruleId, seedStaffUserIds.projectLead, seedStaffUserIds.admin, rows[0].now],
      );
      const added = {
        expectedVersion: 0,
        change: "relaxation_added",
        context: reviewer,
        content: { ...empty, relax: [entry()] },
      };
      expect(await refusal(write(added))).toBe("invalid_argument");
    } finally {
      await app.query("rollback");
    }
    // The internal writer that decide_rule_relaxation uses isn't granted.
    const internal = `select append_project_override($1, 0, '{"kind":"project_override"}',
      'relaxation_added', null, 1, $2, $3, '{}')`;
    expect(await refusal(app.query(internal, [werkNord, reviewer, ruleId]))).toBe("42501");
    expect(await overrides()).toEqual([]);
  });

  it("removes an approved relaxation (tightening, no approval), audited", async () => {
    await approve(await request());
    expect(await write({ content: empty })).toBe(2);
    expect(await overrides()).toEqual([
      { version: 1, content: { ...empty, relax: [entry()] } },
      { version: 2, content: empty },
    ]);
    expect((await audit()).at(-1)).toEqual({
      event_type: "config_override_changed",
      actor_staff_user_id: seedStaffUserIds.projectLead,
      reason_code: null,
      details: { version: 2, change: "relaxation_removed", ruleId, baseDefaultsVersion: 1 },
    });
  });

  it.each([
    [
      "keeps the relaxation",
      { content: { ...empty, relax: [entry({ reasonCode: "collected_outside_platform" })] } },
    ],
    ["also changes a rule", { content: { ...empty, rules: {} } }],
    ["also sets an Agentur's setting", { content: { ...empty, agenturSettings: { x: {} } } }],
    ["names another rule", { content: empty, ruleId: "base-import-address" }],
    ["names an Agentur too", { content: empty, agenturKey: "beispielstadt-nord" }],
    ["names no rule", { content: empty, ruleId: null }],
  ])("refuses a removal that %s (invalid_argument)", async (_label, args) => {
    await approve(await request());
    expect(await refusal(write(args))).toBe("invalid_argument");
    expect(await overrides()).toHaveLength(1);
  });
});

describe("withdraw_rule_relaxation (5.9 step 4)", () => {
  it("withdraws a pending request without a decision, audited, and only once", async () => {
    const id = await request();
    await call(app, "withdraw_rule_relaxation", { requestId: id, context: pl });
    expect(await requests()).toMatchObject([{ status: "withdrawn", decided_by: null }]);
    expect((await audit()).at(-1)).toEqual({
      event_type: "rule_relaxation_withdrawn",
      actor_staff_user_id: seedStaffUserIds.projectLead,
      reason_code: null,
      details: { relaxationRequestId: id, ruleId },
    });
    expect(
      await refusal(call(app, "withdraw_rule_relaxation", { requestId: id, context: pl })),
    ).toBe("relaxation_not_open");
    expect(await refusal(approve(id))).toBe("relaxation_not_open");
    // A new request for the rule is possible again.
    expect(await refusal(request())).toBe("ok");
  });
});
