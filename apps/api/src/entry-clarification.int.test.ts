import { createDb, seedProjectIds, seedRegionIds, seedStaffUserIds, seedWaves } from "@transfer/db";
import {
  acceptDsvScan,
  call,
  externalDsvOffer,
  informedParticipation,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "@transfer/db/testing";
import { EntryClarificationState, ReviewQueue } from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// The entry clarification (process-and-lifecycle.md, the entry clarification) against
// transfer_test: the PL's pending code, the escalation to the region's manager and the manager's
// instruction in "Freigaben"; the sources are read by those two only and never reach the history,
// a log or the queue's identifiers. Synthetic values only.
const { app, db, logs } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord } = seedProjectIds;
const { projectLead, consultant, backOffice, regionalOperationsManager } = seedStaffUserIds;
const w1 = seedWaves.find((wave) => wave.code === "W1")!;
const staff = {} as Record<string, { Cookie: string }>;
const sources = { pending: "Akte 12, Vermerk vom 3.4.", instruction: "Rechtsrat Kanzlei, Az. 77" };

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice, regionalOperationsManager]) {
    staff[id] = await login(app, id);
  }
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  logs.length = 0;
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

const request = (method: string, path: string, as: string, body?: unknown) =>
  app.request(
    `/api/v1${path}`,
    method === "GET" ? { headers: staff[as]! } : jsonRequest(method, body, staff[as]!),
  );
const sql = (text: string, params: unknown[] = []) => owner.$client.query(text, params);

/** A signed DSV (the participant's signature only) whose planned start was yesterday. */
async function signed() {
  const id = await informedParticipation(owner.$client, {
    projectId: werkNord,
    entryWaveId: w1.id,
  });
  await externalDsvOffer(owner.$client, id);
  const {
    rows: [{ earlier }],
  } = await sql("select (berlin_today() - 3)::text as earlier");
  const scan = await acceptDsvScan(owner.$client, id, { participant: earlier });
  const version = (await sql("select status_version from participation where id=$1", [id])).rows[0]
    .status_version;
  await call(owner.$client, "sign_dsv", {
    context: pl,
    participationId: id,
    scanId: scan,
    statusVersion: version,
  });
  await sql(
    "update participation set offer_deadline = berlin_today() - 20, tg_start = berlin_today() - 1 where id = $1",
    [id],
  );
  return id;
}
const state = async (id: string, as: string = projectLead) => {
  const res = await request("GET", `/participations/${id}/entry-clarification`, as);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return readJson(res, EntryClarificationState);
};
const record = (id: string, statusVersion: number, over: Record<string, unknown> = {}) =>
  request("POST", `/participations/${id}/entry-clarification`, projectLead, {
    code: "awaiting_asu_proof",
    source: sources.pending,
    statusVersion,
    ...over,
  });
const escalate = (id: string, statusVersion: number, as: string = projectLead) =>
  request("POST", `/participations/${id}/entry-clarification/escalation`, as, { statusVersion });
const instruct = (
  clarificationId: string,
  statusVersion: number,
  as: string = regionalOperationsManager,
) =>
  request("POST", `/entry-clarifications/${clarificationId}/instruction`, as, {
    code: "legal_advice_obtained",
    source: sources.instruction,
    statusVersion,
  });
const queue = async (as: string = regionalOperationsManager) =>
  readJson(await request("GET", "/reviews", as), ReviewQueue);
const codes = async (res: Response, status: number) => {
  expect(res.status).toBe(status);
  return ((await res.json()) as { errors: { pointer: string; code: string }[] }).errors.map(
    ({ pointer, code }) => `${pointer}:${code}`,
  );
};

describe("GET /participations/{id}/entry-clarification", () => {
  it("opens the day after the planned start with the paths whose guards pass", async () => {
    const id = await signed();
    const open = await state(id);
    expect(open.clarification).toBeNull();
    // No complete packet: no reconciliation; the latest entry date allows a new start.
    expect(open.actions).toMatchObject({
      open: true,
      reconciliation: false,
      newStartDate: true,
      recordPending: true,
      escalate: false,
      instruct: false,
    });
    expect(open.capabilities).toEqual({ record: true, escalate: false });
    await sql("update participation set tg_start = berlin_today() where id = $1", [id]);
    expect((await state(id)).actions.open).toBe(false);
  });

  it("is the PL's and back office's; a consultant 403, an unknown participation 404", async () => {
    const id = await signed();
    expect((await state(id, backOffice)).capabilities).toEqual({ record: false, escalate: false });
    await expectProblem(
      await request("GET", `/participations/${id}/entry-clarification`, consultant),
      403,
      "forbidden",
    );
    await expectProblem(
      await request("GET", `/participations/${randomUUID()}/entry-clarification`, projectLead),
      404,
      "not-found",
    );
  });
});

describe("the PL's record and escalation", () => {
  it("records the pending code; the PL reads the source, the history and the logs never do", async () => {
    const id = await signed();
    const version = (await state(id)).statusVersion;
    const res = await record(id, version);
    expect(res.status).toBe(200);
    const after = await readJson(res, EntryClarificationState);
    expect(after.clarification?.pending).toMatchObject({
      code: "awaiting_asu_proof",
      source: sources.pending,
    });
    expect(after.actions).toMatchObject({ recordPending: true, escalate: true });
    const history = await (
      await request("GET", `/participations/${id}/history`, projectLead)
    ).text();
    expect(history).toContain("entry_clarification_recorded");
    expect(history).toContain("awaiting_asu_proof");
    expect(history).not.toContain("Akte");
    expect(JSON.stringify(logs)).not.toContain("Akte");
  });

  it("is refused against a stale status version (409) and before the day after the start (422)", async () => {
    const id = await signed();
    const version = (await state(id)).statusVersion;
    await sql("update participation set status_version = status_version + 1 where id = $1", [id]);
    expect(await codes(await record(id, version), 409)).toEqual([
      "/statusVersion:stale_status_version",
    ]);
    await sql("update participation set tg_start = berlin_today() where id = $1", [id]);
    expect(await codes(await record(id, version + 1), 422)).toEqual([":clarification_not_open"]);
  });

  it("is the project's PL's only: back office, a consultant and the manager are refused", async () => {
    const id = await signed();
    const version = (await state(id)).statusVersion;
    for (const as of [backOffice, consultant, regionalOperationsManager]) {
      const res = await request("POST", `/participations/${id}/entry-clarification`, as, {
        code: "awaiting_asu_proof",
        source: sources.pending,
        statusVersion: version,
      });
      expect([as, res.status]).toEqual([as, 403]);
    }
    // A source the form refuses is a validation error, never a stored value.
    await expectProblem(await record(id, version, { source: "a\nb" }), 400, "validation-error");
    await expectProblem(
      await record(id, version, { code: "dpo_instruction" }),
      400,
      "validation-error",
    );
    await sql("delete from project_membership where project_id=$1 and staff_user_id=$2", [
      werkNord,
      projectLead,
    ]);
    expect(
      (await request("GET", `/participations/${id}/entry-clarification`, projectLead)).status,
    ).toBe(404);
  });

  it("escalates a documented case once, then only the manager's instruction follows", async () => {
    const id = await signed();
    const version = (await state(id)).statusVersion;
    expect(await codes(await escalate(id, version), 422)).toEqual([
      ":clarification_not_documented",
    ]);
    await record(id, version);
    const result = await readJson(await escalate(id, version), EntryClarificationState);
    expect(result.clarification?.escalatedOn).not.toBeNull();
    expect(result.actions).toMatchObject({
      recordPending: false,
      escalate: false,
      instruct: true,
    });
    expect(await codes(await escalate(id, version), 422)).toEqual([":already_escalated"]);
    expect(await codes(await record(id, version), 422)).toEqual([":clarification_escalated"]);
  });
});

async function escalated() {
  const id = await signed();
  const version = (await state(id)).statusVersion;
  await record(id, version);
  await escalate(id, version);
  const { id: clarificationId } = (await state(id)).clarification!;
  return { id, version, clarificationId };
}

describe("the manager's instruction in Freigaben", () => {
  it("lists the escalated case without a name or id, and the manager records the instruction", async () => {
    const { id, version, clarificationId } = await escalated();
    const { clarifications } = await queue();
    expect(clarifications).toHaveLength(1);
    expect(clarifications[0]).toMatchObject({
      id: clarificationId,
      projectId: werkNord,
      pendingCode: "awaiting_asu_proof",
      pendingSource: sources.pending,
      statusVersion: version,
      capabilities: { instruct: true },
    });
    // The queue names the case, not the participation or the person.
    expect(JSON.stringify(clarifications)).not.toContain(id);
    expect(Object.keys(clarifications[0]!)).not.toContain("participationId");
    const res = await instruct(clarificationId, version);
    expect(res.status).toBe(204);
    expect((await queue()).clarifications).toEqual([]);
    // The case stays open and nothing changed: the status is the same.
    const after = await state(id);
    expect(after.actions.open).toBe(true);
    expect(after.clarification?.instruction).toMatchObject({
      code: "legal_advice_obtained",
      source: sources.instruction,
    });
    expect(
      (await sql("select status::text, dsv_status::text from participation where id=$1", [id]))
        .rows[0],
    ).toEqual({ status: "informed", dsv_status: "dsv_signed" });
    const history = await (
      await request("GET", `/participations/${id}/history`, projectLead)
    ).text();
    expect(history).toContain("entry_clarification_instructed");
    expect(history).not.toContain("Kanzlei");
    expect(JSON.stringify(logs)).not.toContain("Kanzlei");
    expect(await codes(await instruct(clarificationId, version), 422)).toEqual([
      ":already_instructed",
    ]);
  });

  it("is never the PL's: the PL who tries is refused, as is every other role; the queue is the manager's", async () => {
    const { version, clarificationId } = await escalated();
    for (const as of [projectLead, backOffice, consultant]) {
      const res = await instruct(clarificationId, version, as);
      expect([as, res.status]).toEqual([as, 403]);
    }
    await expectProblem(await request("GET", "/reviews", projectLead), 403, "forbidden");
    expect(
      (await sql("select instruction_code from entry_clarification")).rows[0].instruction_code,
    ).toBeNull();
  });

  it("is refused for a stale version (409), another region's manager (403) and an unknown case (404)", async () => {
    const { version, clarificationId } = await escalated();
    expect(await codes(await instruct(clarificationId, version + 1), 409)).toEqual([
      "/statusVersion:stale_status_version",
    ]);
    await expectProblem(await instruct(randomUUID(), version), 404, "not-found");
    // Losing the role (or the region) loses the right at the function.
    await sql("update staff_org_role set region_id = $1 where staff_user_id = $2", [
      seedRegionIds.sued,
      regionalOperationsManager,
    ]);
    await expectProblem(await instruct(clarificationId, version), 403, "forbidden");
    expect((await queue()).clarifications).toEqual([]);
  });

  it("leaves the queue once the participation left informed", async () => {
    const { id } = await escalated();
    await sql("update participation set tg_start = berlin_today() + 3 where id = $1", [id]);
    expect((await queue()).clarifications).toEqual([]);
  });
});
