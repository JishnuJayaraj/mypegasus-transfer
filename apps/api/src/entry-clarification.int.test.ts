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
/** The revision of the unresolved clarification the tab shows, 0 while there is none. */
const revisionOf = async (id: string) => (await state(id)).clarification?.revision ?? 0;
const record = async (id: string, statusVersion: number, over: Record<string, unknown> = {}) =>
  request("POST", `/participations/${id}/entry-clarification`, projectLead, {
    code: "awaiting_asu_proof",
    source: sources.pending,
    statusVersion,
    revision: await revisionOf(id),
    ...over,
  });
const escalate = async (
  id: string,
  statusVersion: number,
  as: string = projectLead,
  over: Record<string, unknown> = {},
) =>
  request("POST", `/participations/${id}/entry-clarification/escalation`, as, {
    statusVersion,
    revision: await revisionOf(id),
    ...over,
  });
const answer = async (
  path: "instruction" | "request",
  clarificationId: string,
  statusVersion: number,
  as: string = regionalOperationsManager,
  over: Record<string, unknown> = {},
) =>
  request("POST", `/entry-clarifications/${clarificationId}/${path}`, as, {
    code: path === "instruction" ? "legal_advice_obtained" : "date_unclear",
    source: sources.instruction,
    statusVersion,
    revision:
      (await sql("select revision from entry_clarification where id = $1", [clarificationId]))
        .rows[0]?.revision ?? 0,
    ...over,
  });
const instruct = (
  clarificationId: string,
  statusVersion: number,
  as: string = regionalOperationsManager,
  over: Record<string, unknown> = {},
) => answer("instruction", clarificationId, statusVersion, as, over);
const ask = (
  clarificationId: string,
  statusVersion: number,
  as: string = regionalOperationsManager,
  over: Record<string, unknown> = {},
) => answer("request", clarificationId, statusVersion, as, over);
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
    expect(after.clarification).toMatchObject({ stage: "documented", revision: 1 });
    expect(after.clarification?.steps).toMatchObject([
      { kind: "recorded", code: "awaiting_asu_proof", source: sources.pending },
    ]);
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

  it("refuses a note or an escalation made against a revision the PL didn't read (409 at /revision)", async () => {
    const id = await signed();
    const version = (await state(id)).statusVersion;
    // Two tabs read an empty case; the first saves, the second would overwrite it.
    expect((await record(id, version, { revision: 0 })).status).toBe(200);
    expect(
      await codes(await record(id, version, { revision: 0, source: "Zweiter Tab" }), 409),
    ).toEqual(["/revision:stale_clarification"]);
    // The tab that confirmed an escalation of revision 1 can't escalate the note replaced meanwhile.
    expect((await record(id, version, { revision: 1, source: "Ersetzt" })).status).toBe(200);
    expect(await codes(await escalate(id, version, projectLead, { revision: 1 }), 409)).toEqual([
      "/revision:stale_clarification",
    ]);
    expect((await state(id)).clarification).toMatchObject({ stage: "documented", revision: 2 });
    expect((await escalate(id, version)).status).toBe(200);
  });

  it("is the project's PL's only: back office, a consultant and the manager are refused", async () => {
    const id = await signed();
    const version = (await state(id)).statusVersion;
    for (const as of [backOffice, consultant, regionalOperationsManager]) {
      const res = await request("POST", `/participations/${id}/entry-clarification`, as, {
        code: "awaiting_asu_proof",
        source: sources.pending,
        statusVersion: version,
        revision: 0,
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
    expect(result.clarification).toMatchObject({ stage: "escalated", revision: 2 });
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
  it("asks the PL again: the PL replies, escalates again and the manager continues; every step is kept", async () => {
    const { id, version, clarificationId } = await escalated();
    const res = await ask(clarificationId, version);
    expect(res.status).toBe(204);
    expect((await queue()).clarifications).toEqual([]);
    const returned = await state(id);
    expect(returned.clarification).toMatchObject({ stage: "returned", revision: 3 });
    expect(returned.actions).toMatchObject({
      recordPending: true,
      escalate: false,
      instruct: false,
    });
    expect(returned.capabilities).toEqual({ record: true, escalate: false });
    // The PL's reply is a new note; escalating it queues the case again with the whole history.
    const replied = await readJson(
      await record(id, version, { code: "awaiting_legal_advice", source: "Antwort der PL" }),
      EntryClarificationState,
    );
    expect(replied.clarification?.stage).toBe("documented");
    await escalate(id, version);
    const [item] = (await queue()).clarifications;
    expect(item!.steps.map((step) => step.kind)).toEqual([
      "recorded",
      "escalated",
      "requested",
      "recorded",
      "escalated",
    ]);
    expect(await instruct(clarificationId, version).then((r) => r.status)).toBe(204);
    const history = await (
      await request("GET", `/participations/${id}/history`, projectLead)
    ).text();
    expect(history).toContain("entry_clarification_requested");
    expect(history).not.toContain("Kanzlei");
    expect(
      (await sql("select status::text from participation where id=$1", [id])).rows[0].status,
    ).toBe("informed");
  });

  it("is refused to the PL and other roles, and takes only its own codes", async () => {
    const { version, clarificationId } = await escalated();
    for (const as of [projectLead, backOffice, consultant]) {
      expect([as, (await ask(clarificationId, version, as)).status]).toEqual([as, 403]);
    }
    await expectProblem(
      await ask(clarificationId, version, undefined, { code: "dpo_instruction" }),
      400,
      "validation-error",
    );
  });

  it("keeps an escalated case reachable when the planned start moved on, in the card and the queue", async () => {
    const { id, version, clarificationId } = await escalated();
    await sql(
      "update participation set offer_deadline = berlin_today() - 20, tg_start = berlin_today() + 5 where id = $1",
      [id],
    );
    // The participation is still informed: the unresolved case stays on the tab, in Freigaben, and
    // can be answered.
    const moved = await state(id);
    expect(moved.actions).toMatchObject({ open: true, instruct: true });
    expect(moved.clarification).toMatchObject({ id: clarificationId, stage: "escalated" });
    const [item] = (await queue()).clarifications;
    expect(item).toMatchObject({ id: clarificationId, capabilities: { answer: true } });
    expect(await instruct(clarificationId, version).then((r) => r.status)).toBe(204);
    // Instructed, it ended with its start: the card closes while the start lies ahead.
    expect((await state(id)).actions.open).toBe(false);
  });

  it("lists the escalated case without a name or id, and the manager records the instruction", async () => {
    const { id, version, clarificationId } = await escalated();
    const { clarifications } = await queue();
    expect(clarifications).toHaveLength(1);
    expect(clarifications[0]).toMatchObject({
      id: clarificationId,
      projectId: werkNord,
      revision: 2,
      statusVersion: version,
      capabilities: { answer: true },
    });
    expect(clarifications[0]!.steps.map((step) => [step.kind, step.code, step.source])).toEqual([
      ["recorded", "awaiting_asu_proof", sources.pending],
      ["escalated", "awaiting_asu_proof", sources.pending],
    ]);
    // The queue names the case, not the participation or the person.
    expect(JSON.stringify(clarifications)).not.toContain(id);
    expect(Object.keys(clarifications[0]!)).not.toContain("participationId");
    const res = await instruct(clarificationId, version);
    expect(res.status).toBe(204);
    expect((await queue()).clarifications).toEqual([]);
    // The case stays open and nothing changed: the status is the same.
    const after = await state(id);
    expect(after.actions.open).toBe(true);
    expect(after.clarification?.stage).toBe("instructed");
    expect(after.clarification?.steps.at(-1)).toMatchObject({
      kind: "instructed",
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

  it("is refused for a stale version or revision (409) and an unknown case (404)", async () => {
    const { version, clarificationId } = await escalated();
    expect(await codes(await instruct(clarificationId, version + 1), 409)).toEqual([
      "/statusVersion:stale_status_version",
    ]);
    expect(
      await codes(await instruct(clarificationId, version, undefined, { revision: 1 }), 409),
    ).toEqual(["/revision:stale_clarification"]);
    await expectProblem(await instruct(randomUUID(), version), 404, "not-found");
  });

  it("hides a clarification outside the manager's regions exactly as an unknown one (404), before any permission", async () => {
    const { version, clarificationId } = await escalated();
    const unknown = await instruct(randomUUID(), version);
    // Losing the region (or the role) makes the case invisible, not forbidden.
    await sql("update staff_org_role set region_id = $1 where staff_user_id = $2", [
      seedRegionIds.sued,
      regionalOperationsManager,
    ]);
    for (const path of ["instruction", "request"] as const) {
      const outside = await answer(path, clarificationId, version);
      expect(outside.status).toBe(404);
      expect(await outside.clone().json()).toMatchObject({
        type: ((await unknown.clone().json()) as { type: string }).type,
        status: 404,
      });
    }
    expect((await queue()).clarifications).toEqual([]);
    // The project's PL sees the case's project and is forbidden to answer: 403, not 404.
    await expectProblem(await instruct(clarificationId, version, projectLead), 403, "forbidden");
    expect(
      (await sql("select instruction_code from entry_clarification")).rows[0].instruction_code,
    ).toBeNull();
  });

  it("leaves the queue once the participation left informed", async () => {
    const { id } = await escalated();
    await sql("alter table participation disable trigger user");
    try {
      await sql(
        "update participation set status = 'contacted', dsv_status = 'not_offered', profiling_status = 'not_started' where id = $1",
        [id],
      );
      expect((await queue()).clarifications).toEqual([]);
    } finally {
      await sql(
        "update participation set status = 'informed', dsv_status = 'dsv_signed' where id = $1",
        [id],
      );
      await sql("alter table participation enable trigger user");
    }
  });
});
