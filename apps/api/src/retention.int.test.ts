import { createDb, seedProjectIds, seedStaffUserIds } from "@transfer/db";
import { call, pl, resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { FundingView, SettlementDatesView } from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// Retention's inputs (data-protection.md, funding and settlement dates; Q52, Q217) against
// transfer_test: back office records the settlement dates and the funding against the values read;
// a nearby role (the PL, a consultant) is refused, so is back office after losing its membership;
// visibility (404) before permission (403) before state (409/422). Synthetic data only.
const { app, db, logs } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord } = seedProjectIds;
const { projectLead, consultant, backOffice } = seedStaffUserIds;
const staff = {} as Record<string, { Cookie: string }>;

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice]) staff[id] = await login(app, id);
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  logs.length = 0;
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

const sql = (text: string, params: unknown[] = []) => owner.$client.query(text, params);
const none = { kugFinalSettlementDate: null, measure110SettlementDate: null };
const putDates = (body: object, as: string, project: string = werkNord) =>
  app.request(`/api/v1/projects/${project}/settlement-dates`, jsonRequest("PUT", body, staff[as]!));
const codesOf = async (res: Response, status: number) => {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { errors?: { code: string; pointer?: string }[] };
  return (body.errors ?? []).map((e) => `${e.pointer ?? ""}:${e.code}`);
};
const loseMembership = (staffUserId: string) =>
  sql("delete from project_membership where project_id = $1 and staff_user_id = $2", [
    werkNord,
    staffUserId,
  ]);

const participant = () =>
  call(owner.$client, "create_participation", { projectId: werkNord, context: pl });
const unknown = { funded110: "unknown", source: null };
const put = (id: string, body: object, as: string) =>
  app.request(`/api/v1/participations/${id}/funding`, jsonRequest("PUT", body, staff[as]!));
const get = (id: string, as: string) =>
  app.request(`/api/v1/participations/${id}/funding`, { headers: staff[as]! });

describe("settlement dates (Q52)", () => {
  it("are set by back office against the dates read, and read by whoever sees the project", async () => {
    const before = await readJson(
      await app.request(`/api/v1/projects/${werkNord}/settlement-dates`, {
        headers: staff[projectLead]!,
      }),
      SettlementDatesView,
    );
    expect(before).toEqual({
      ...none,
      required: {
        kugFinalSettlementDate: false,
        measure110SettlementDate: false,
        fundingUnknown: false,
      },
      capabilities: { set: false },
    });
    const res = await putDates(
      { ...none, kugFinalSettlementDate: "2027-06-30", expected: none },
      backOffice,
    );
    expect(await readJson(res, SettlementDatesView)).toMatchObject({
      kugFinalSettlementDate: "2027-06-30",
      measure110SettlementDate: null,
      capabilities: { set: true },
    });
    const events = await sql(
      "select participation_id, details from audit_event where event_type = 'settlement_dates_set'",
    );
    expect(events.rows).toEqual([
      { participation_id: null, details: { fields: ["kugFinalSettlementDate"] } },
    ]);
    expect(logs.join("")).not.toContain("2027-06-30");
  });

  it("orders 404 (hidden, membership lost) before 403 before 409/422", async () => {
    const stale = {
      ...none,
      kugFinalSettlementDate: "2027-06-30",
      expected: { ...none, kugFinalSettlementDate: "2020-01-01" },
    };
    await expectProblem(await putDates(stale, backOffice, randomUUID()), 404, "not-found");
    // A nearby role: the PL and the consultant, before the stale dates.
    await expectProblem(await putDates(stale, projectLead), 403, "forbidden");
    await expectProblem(await putDates(stale, consultant), 403, "forbidden");
    expect(await codesOf(await putDates(stale, backOffice), 409)).toEqual([
      "/expected:stale_settlement_dates",
    ]);
    expect(await codesOf(await putDates({ ...none, expected: none }, backOffice), 422)).toEqual([
      ":project_unchanged",
    ]);
    await expectProblem(
      await putDates({ ...none, kugFinalSettlementDate: "2027-02-30", expected: none }, backOffice),
      400,
      "validation-error",
    );
    await loseMembership(backOffice);
    await expectProblem(
      await putDates({ ...none, kugFinalSettlementDate: "2027-06-30", expected: none }, backOffice),
      404,
      "not-found",
    );
    expect(
      (
        await sql(
          "select count(*)::int as n from audit_event where event_type = 'settlement_dates_set'",
        )
      ).rows[0].n,
    ).toBe(0);
  });
});

describe("the funding (Q217)", () => {
  it("is recorded by back office with its source against the value read; the history shows the code", async () => {
    const id = await participant();
    expect(await readJson(await get(id, projectLead), FundingView)).toEqual({
      ...unknown,
      setAt: null,
      capabilities: { set: false },
    });
    const res = await put(
      id,
      { funded110: "known_yes", source: "Bescheid 4711", expected: unknown },
      backOffice,
    );
    const view = await readJson(res, FundingView);
    expect(view).toMatchObject({
      funded110: "known_yes",
      source: "Bescheid 4711",
      capabilities: { set: true },
    });
    expect(view.setAt).not.toBeNull();
    const events = await sql(
      "select details from audit_event where event_type = 'funding_status_set' and participation_id = $1",
      [id],
    );
    expect(events.rows).toEqual([{ details: { funded110: "known_yes" } }]);
    expect(logs.join("")).not.toContain("Bescheid");
    const history = await app.request(`/api/v1/participations/${id}/history`, {
      headers: staff[projectLead]!,
    });
    expect(JSON.stringify(await history.json())).not.toContain("Bescheid");
    // The settlement dates now ask for the §110 settlement.
    const dates = await readJson(
      await app.request(`/api/v1/projects/${werkNord}/settlement-dates`, {
        headers: staff[backOffice]!,
      }),
      SettlementDatesView,
    );
    expect(dates.required.measure110SettlementDate).toBe(true);
  });

  it("orders 404 (hidden, membership lost) before 403 before 409/422", async () => {
    const id = await participant();
    const stale = {
      funded110: "known_no",
      source: "Akte 1",
      expected: { funded110: "known_yes", source: "x" },
    };
    await expectProblem(await put(randomUUID(), stale, backOffice), 404, "not-found");
    await expectProblem(await put(id, stale, projectLead), 403, "forbidden");
    await expectProblem(await get(id, consultant), 403, "forbidden");
    expect(await codesOf(await put(id, stale, backOffice), 409)).toEqual([
      "/expected:stale_funding",
    ]);
    await put(id, { funded110: "known_no", source: "Akte 1", expected: unknown }, backOffice);
    expect(
      await codesOf(
        await put(
          id,
          {
            funded110: "known_no",
            source: "Akte 1",
            expected: { funded110: "known_no", source: "Akte 1" },
          },
          backOffice,
        ),
        422,
      ),
    ).toEqual([":funding_unchanged"]);
    await expectProblem(
      await put(id, { funded110: "maybe", source: "Akte 1", expected: unknown }, backOffice),
      400,
      "validation-error",
    );
    await loseMembership(backOffice);
    await expectProblem(
      await put(
        id,
        {
          funded110: "known_yes",
          source: "Akte 2",
          expected: { funded110: "known_no", source: "Akte 1" },
        },
        backOffice,
      ),
      404,
      "not-found",
    );
    expect((await sql("select funded110 from participation where id = $1", [id])).rows).toEqual([
      { funded110: "known_no" },
    ]);
  });
});
