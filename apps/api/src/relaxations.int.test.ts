import { ManualClock } from "@transfer/adapters";
import {
  auditEvent,
  configRelaxationRequest,
  createDb,
  eq,
  projectMembership,
  seedProjectIds,
  seedStaffUserIds,
  sql,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { ProjectConfig } from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// Slice 2 plan 5.3, 5.4, 5.9 and 5.12 (PR 2d-2): rule relaxations with approval (Q75, round 8,
// R2; AC-15, AC-16, AC-45).
const { app, db } = testApp({ clock: new ManualClock(new Date("2026-10-17T10:00:00Z")) });
const owner = createDb(testDatabaseUrls().owner);
const auth: Record<string, { Cookie: string }> = {};
const { werkNord, lagerSued } = seedProjectIds;
const rom = seedStaffUserIds.regionalOperationsManager;
const ruleId = "base-import-birthDate";

const configPath = (projectId: string) => `/api/v1/projects/${projectId}/config`;
const get = async (projectId: string, user = "projectLead") =>
  readJson(await app.request(configPath(projectId), { headers: auth[user] }), ProjectConfig);
const ask = (body: unknown, user = "projectLead", projectId: string = werkNord) =>
  app.request(`${configPath(projectId)}/relaxations`, jsonRequest("POST", body, auth[user]));
const decide = (requestId: string, body: unknown, user = "regionalOperationsManager") =>
  app.request(
    `/api/v1/config/relaxations/${requestId}/decision`,
    jsonRequest("POST", body, auth[user]),
  );
const withdraw = (requestId: string, user = "projectLead") =>
  app.request(
    `/api/v1/config/relaxations/${requestId}/withdrawal`,
    jsonRequest("POST", {}, auth[user]),
  );
const remove = (rule: string, query: string, user = "projectLead") =>
  app.request(`${configPath(werkNord)}/relaxations/${rule}?${query}`, {
    method: "DELETE",
    headers: { ...auth[user], Origin: "http://localhost:5173" },
  });
const codes = async (res: Response, status = 422, type = "domain-error") =>
  (await expectProblem(res, status, type)).errors?.map(({ code }) => code);

/** Asks for `rule` as the PL and returns the open request's id. */
async function requested(rule = ruleId, reasonCode = "source_data_not_provided") {
  const res = await ask({ ruleId: rule, reasonCode });
  expect(res.status).toBe(200);
  const config = await readJson(res, ProjectConfig);
  return config.relaxationRequests.find((r) => r.ruleId === rule)!.id;
}
const events = () =>
  owner
    .select({
      type: auditEvent.eventType,
      actor: auditEvent.actorStaffUserId,
      reasonCode: auditEvent.reasonCode,
      details: auditEvent.details,
    })
    .from(auditEvent)
    .where(sql`${auditEvent.eventType}::text like 'rule_relaxation_%'
      or ${auditEvent.eventType} = 'config_override_changed'`)
    .orderBy(auditEvent.seq);

beforeAll(async () => {
  await resetTestDatabase({ seed: true });
  for (const user of Object.keys(seedStaffUserIds) as (keyof typeof seedStaffUserIds)[]) {
    auth[user] = await login(app, seedStaffUserIds[user]);
  }
});
beforeEach(() => resetTestDatabase({ seed: true }));
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

describe("a relaxation takes effect only after another person's approval (AC-15)", () => {
  it("is requested by the PL, approved by the regional operations manager, then in the override", async () => {
    const id = await requested();
    const asked = await get(werkNord);
    expect(asked.override).toEqual({ version: 0, agenturSettings: [], relaxations: [] });
    expect(asked.relaxationRequests).toEqual([
      {
        id,
        ruleId,
        reasonCode: "source_data_not_provided",
        requestedBy: seedStaffUserIds.projectLead,
        requestedOn: "2026-10-17",
        capabilities: { decide: false, withdraw: true },
      },
    ]);
    expect(asked.relaxableRules.map((r) => r.ruleId)).not.toContain(ruleId);
    expect((await get(werkNord, "regionalOperationsManager")).relaxationRequests).toMatchObject([
      { id, capabilities: { decide: true, withdraw: false } },
    ]);

    const res = await decide(id, { decision: "approved", expectedVersion: 0 });
    expect(res.status).toBe(200);
    const config = await readJson(res, ProjectConfig);
    expect(config.override).toEqual({
      version: 1,
      agenturSettings: [],
      relaxations: [
        {
          ruleId,
          reasonCode: "source_data_not_provided",
          approvedBy: rom,
          approvedOn: "2026-10-17",
        },
      ],
    });
    expect(config.relaxationRequests).toEqual([]);
    expect(config.relaxableRules.map((r) => r.ruleId)).not.toContain(ruleId);
    // AC-45: both configuration-dependent types carry the base-defaults version (R26).
    expect(await events()).toEqual([
      {
        type: "rule_relaxation_requested",
        actor: seedStaffUserIds.projectLead,
        reasonCode: "source_data_not_provided",
        details: { relaxationRequestId: id, ruleId, baseDefaultsVersion: 1 },
      },
      {
        type: "config_override_changed",
        actor: rom,
        reasonCode: null,
        details: { version: 1, change: "relaxation_added", ruleId, baseDefaultsVersion: 1 },
      },
      {
        type: "rule_relaxation_approved",
        actor: rom,
        reasonCode: "source_data_not_provided",
        details: { relaxationRequestId: id, ruleId, version: 1, baseDefaultsVersion: 1 },
      },
    ]);
  });

  it("is never decided by the requester, nor by anyone but the regional operations manager (R2)", async () => {
    // The regional operations manager is also this project's PL here (D6) and asks.
    await owner
      .insert(projectMembership)
      .values({ projectId: werkNord, staffUserId: rom, role: "project_lead" });
    const res = await ask(
      { ruleId, reasonCode: "collected_outside_platform" },
      "regionalOperationsManager",
    );
    const [request] = (await readJson(res, ProjectConfig)).relaxationRequests;
    expect(request!.capabilities).toEqual({ decide: false, withdraw: true });
    for (const user of ["regionalOperationsManager", "projectLead", "admin", "consultant"]) {
      await expectProblem(
        await decide(request!.id, { decision: "approved", expectedVersion: 0 }, user),
        403,
        "forbidden",
      );
    }
    expect((await get(werkNord)).override.version).toBe(0);
  });

  it("records a rejection and a withdrawal without changing the configuration", async () => {
    const rejected = await requested();
    const res = await decide(rejected, { decision: "rejected" });
    expect((await readJson(res, ProjectConfig)).relaxationRequests).toEqual([]);
    const withdrawn = await requested();
    expect((await readJson(await withdraw(withdrawn), ProjectConfig)).override.version).toBe(0);
    expect((await events()).map(({ type, details }) => [type, details])).toEqual([
      [
        "rule_relaxation_requested",
        { relaxationRequestId: rejected, ruleId, baseDefaultsVersion: 1 },
      ],
      ["rule_relaxation_rejected", { relaxationRequestId: rejected, ruleId }],
      [
        "rule_relaxation_requested",
        { relaxationRequestId: withdrawn, ruleId, baseDefaultsVersion: 1 },
      ],
      ["rule_relaxation_withdrawn", { relaxationRequestId: withdrawn, ruleId }],
    ]);
    // Decided or withdrawn once only.
    expect(await codes(await decide(rejected, { decision: "rejected" }))).toEqual([
      "relaxation_not_open",
    ]);
    expect(await codes(await withdraw(withdrawn))).toEqual(["relaxation_not_open"]);
  });

  it("is removed by the PL as a new override version (tightening, no approval), audited", async () => {
    await decide(await requested(), { decision: "approved", expectedVersion: 0 });
    await expectProblem(
      await remove(ruleId, "expectedVersion=1", "regionalOperationsManager"),
      403,
      "forbidden",
    );
    await expectProblem(await remove(ruleId, "expectedVersion=0"), 409, "conflict");
    await expectProblem(await remove("base-import-address", "expectedVersion=1"), 404, "not-found");
    const res = await remove(ruleId, "expectedVersion=1");
    expect(res.status).toBe(200);
    const config = await readJson(res, ProjectConfig);
    expect(config.override).toEqual({ version: 2, agenturSettings: [], relaxations: [] });
    expect(config.relaxableRules.map((r) => r.ruleId)).toContain(ruleId);
    expect((await events()).at(-1)).toEqual({
      type: "config_override_changed",
      actor: seedStaffUserIds.projectLead,
      reasonCode: null,
      details: { version: 2, change: "relaxation_removed", ruleId, baseDefaultsVersion: 1 },
    });
  });
});

describe("POST …/config/relaxations", () => {
  it("allows one open request per rule, and none for a relaxed rule", async () => {
    const id = await requested();
    expect(await codes(await ask({ ruleId, reasonCode: "collected_outside_platform" }))).toEqual([
      "relaxation_request_open",
    ]);
    await decide(id, { decision: "approved", expectedVersion: 0 });
    expect(await codes(await ask({ ruleId, reasonCode: "collected_outside_platform" }))).toEqual([
      "relaxation_exists",
    ]);
  });

  it("checks the rule against the snapshot: operational_default in some chain (5.9 step 2)", async () => {
    const reasonCode = "agentur_confirmed_not_required";
    expect(await codes(await ask({ ruleId: "base-dsv-signed-scan", reasonCode }))).toEqual([
      "override_invalid",
      "relaxation_locked",
    ]);
    expect(
      await codes(await ask({ ruleId: "beispielstadt-sued-private-email", reasonCode })),
    ).toEqual(["override_invalid", "relaxation_unmatched"]);
    // Once Süd is pinned, its rule is there to relax.
    await app.request(
      `${configPath(werkNord)}/pins`,
      jsonRequest("POST", { agenturKey: "beispielstadt-sued" }, auth.projectLead),
    );
    expect((await get(werkNord)).relaxableRules).toContainEqual({
      ruleId: "beispielstadt-sued-private-email",
      step: "data_collection",
    });
    expect((await ask({ ruleId: "beispielstadt-sued-private-email", reasonCode })).status).toBe(
      200,
    );
  });

  it("takes strict input with a controlled reason code (400)", async () => {
    const res = await ask({ ruleId, reasonCode: "too_much_work" });
    await expectProblem(res, 400, "validation-error");
    const extra = await expectProblem(
      await ask({ ruleId, reasonCode: "source_data_not_provided", approvedBy: rom }),
      400,
      "validation-error",
    );
    expect(extra.errors).toEqual([
      expect.objectContaining({ pointer: "/approvedBy", code: "unrecognized_keys" }),
    ]);
  });

  it("checks visibility and the operation before the rule (404, 403; round 27)", async () => {
    const locked = { ruleId: "base-dsv-signed-scan", reasonCode: "source_data_not_provided" };
    await expectProblem(await ask(locked, "consultant"), 403, "forbidden");
    await expectProblem(await ask(locked, "regionalOperationsManager"), 403, "forbidden");
    await expectProblem(
      await ask(locked, "projectLead", "00000000-0000-4000-9000-0000000000ff"),
      404,
      "not-found",
    );
  });
});

describe("POST /config/relaxations/{requestId}/decision and …/withdrawal", () => {
  it("refuses an approval against a stale override version (409)", async () => {
    const id = await requested();
    await expectProblem(
      await decide(id, { decision: "approved", expectedVersion: 1 }),
      409,
      "conflict",
    );
    await expectProblem(await decide(id, { decision: "approved" }), 400, "validation-error");
    await expectProblem(
      await decide(id, { decision: "rejected", expectedVersion: 0 }),
      400,
      "validation-error",
    );
  });

  it("refuses an approval that would make the override invalid, deciding nothing (AC-16)", async () => {
    // A request for a rule no chain has: only possible as the owner (the request is checked).
    const [{ id } = { id: "" }] = await owner
      .insert(configRelaxationRequest)
      .values({
        projectId: werkNord,
        ruleId: "nord-mobile-x",
        reasonCode: "source_data_not_provided",
        status: "requested",
        requestedBy: seedStaffUserIds.projectLead,
        requestedOn: "2026-10-17",
      })
      .returning({ id: configRelaxationRequest.id });
    expect(await codes(await decide(id!, { decision: "approved", expectedVersion: 0 }))).toEqual([
      "override_invalid",
      "relaxation_unmatched",
    ]);
    const [stored] = await owner
      .select({ status: configRelaxationRequest.status })
      .from(configRelaxationRequest)
      .where(eq(configRelaxationRequest.id, id!));
    expect(stored).toEqual({ status: "requested" });
  });

  it("lets only the project's PL withdraw (403), and reveals no request of an invisible project (404)", async () => {
    const id = await requested();
    for (const user of ["consultant", "regionalOperationsManager", "admin"]) {
      await expectProblem(await withdraw(id, user), 403, "forbidden");
    }
    await expectProblem(await withdraw("00000000-0000-4000-b000-0000000000ff"), 404, "not-found");
    // A project without members (synthetic, as the owner) and a request in it.
    await owner.delete(projectMembership).where(eq(projectMembership.projectId, lagerSued));
    const [{ id: hidden } = { id: "" }] = await owner
      .insert(configRelaxationRequest)
      .values({
        projectId: lagerSued,
        ruleId,
        reasonCode: "source_data_not_provided",
        status: "requested",
        requestedBy: seedStaffUserIds.admin,
        requestedOn: "2026-10-17",
      })
      .returning({ id: configRelaxationRequest.id });
    await expectProblem(await withdraw(hidden!), 404, "not-found");
    await expectProblem(
      await decide(hidden!, { decision: "rejected" }, "consultant"),
      404,
      "not-found",
    );
    // The global role sees it and decides it.
    expect((await decide(hidden!, { decision: "rejected" })).status).toBe(200);
  });
});
