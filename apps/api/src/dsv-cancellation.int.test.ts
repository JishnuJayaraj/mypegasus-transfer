import { MemoryFileStorage } from "@transfer/adapters";
import { createDb, seedProjectIds, seedStaffUserIds, seedWaves } from "@transfer/db";
import {
  acceptDsvScan,
  call,
  changeStatus,
  externalDsvOffer,
  nightly,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "@transfer/db/testing";
import { DocumentView, DsvView, ParticipationDetail, Worklist } from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// The cancellation of a signed DSV, the withdrawal and end-reason routes and the customer notice
// (process-and-lifecycle.md, the cancellation, manual withdrawal and the customer notice; Q46
// verify, Q72, Q213) against transfer_test with memory storage. Visibility (404), then permission
// (403), then state (422, 409). Synthetic data only.
const storage = new MemoryFileStorage();
const { app, db, logs } = testApp({ fileStorage: storage });
const owner = createDb(testDatabaseUrls().owner);
const { werkNord } = seedProjectIds;
const { projectLead, consultant, backOffice, regionalOperationsManager } = seedStaffUserIds;
const w1 = seedWaves.find((wave) => wave.code === "W1")!;
const staff = {} as Record<string, { Cookie: string }>;

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

async function request(method: string, path: string, as: string, body?: unknown) {
  const init = method === "GET" ? { headers: staff[as]! } : jsonRequest(method, body, staff[as]!);
  return app.request(`/api/v1${path}`, init);
}
const sql = (text: string, params: unknown[] = []) => owner.$client.query(text, params);
const codesOf = async (res: Response, status: number) => {
  expect(res.status).toBe(status);
  return ((await res.json()) as { errors: { pointer: string; code: string }[] }).errors.map(
    ({ pointer, code }) => `${pointer}:${code}`,
  );
};
const today = async (offset = 0): Promise<string> =>
  (await sql("select (berlin_today() + $1::int)::text as d", [offset])).rows[0].d;

/** An informed participant of Werk Nord in W1 with a synthetic identity. */
async function participant() {
  const id = await call(owner.$client, "create_participation", {
    projectId: werkNord,
    context: pl,
  });
  await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(owner.$client, id, { field: "status", from: "contacted", to: "informed" });
  await call(owner.$client, "assign_entry_wave", { id, waveId: w1.id, context: pl });
  await sql(
    `insert into participant_identity (participation_id, project_id, personnel_number, first_name,
       last_name, birth_date) values ($1, $2, $3, 'Zofia', 'Synthetik-Aufhebung', '2051-07-29')`,
    [id, werkNord, `P-${id.slice(0, 8)}`],
  );
  return id;
}

/** A participant whose DSV the participant signed on 2026-01-01 (no complete packet). */
async function signed() {
  const id = await participant();
  const offer = await externalDsvOffer(owner.$client, id);
  const scan = await acceptDsvScan(owner.$client, id, { participant: "2026-01-01" });
  const { rows } = await sql("select status_version from participation where id = $1", [id]);
  await call(owner.$client, "sign_dsv", {
    context: pl,
    participationId: id,
    scanId: scan,
    statusVersion: rows[0].status_version,
  });
  return { id, offer };
}

const all = (date: string) => ({ participant: date, customer: date, transfergesellschaft: date });
const file = {
  fileName: "aufhebung.pdf",
  content: Buffer.from("%PDF-1.4\nsynthetic cancellation\n%%EOF").toString("base64"),
};
const uploadCancellation = (
  f: { id: string; offer: string },
  as: string = backOffice,
  signatures: Record<string, string> = all("2026-01-05"),
) =>
  request("POST", `/participations/${f.id}/dsv/cancellation-scans`, as, {
    offerId: f.offer,
    signatures,
    receivedBy: backOffice,
    receivedOn: "2026-01-06",
    file,
  });
const review = (documentId: string, as: string, dsv: unknown) =>
  request("POST", `/documents/${documentId}/dsv-review`, as, { decision: "accepted", dsv });

/** An accepted cancellation, all three signed on 2026-01-05. */
async function cancelled(f: { id: string; offer: string }) {
  const res = await uploadCancellation(f);
  expect(res.status).toBe(201);
  const { id } = await readJson(res, DocumentView);
  expect((await review(id, projectLead, { signatures: all("2026-01-05") })).status).toBe(200);
  return id;
}

const detail = async (id: string, as: string = projectLead) =>
  readJson(await request("GET", `/participations/${id}`, as), ParticipationDetail);
const dsvView = async (id: string, as: string = projectLead) =>
  readJson(await request("GET", `/participations/${id}/dsv`, as), DsvView);
const withdraw = async (id: string, body: Record<string, unknown> = {}, as: string = projectLead) =>
  request("POST", `/participations/${id}/withdrawal`, as, {
    endReason: "placed_direct",
    effectiveDate: "2026-01-06",
    statusVersion: (await detail(id)).statusVersion,
    confirmed: true,
    ...body,
  });
const caseItems = async (id: string, as: string = projectLead) =>
  (await readJson(await request("GET", `/projects/${werkNord}/worklist`, as), Worklist)).items
    .find((item) => item.id === id)!
    .caseItems.map((item) => `${item.kind}:${item.date}`);

describe("the cancellation scan", () => {
  it("is uploaded against the signed offer and reviewed with the three signatures", async () => {
    const f = await signed();
    expect((await dsvView(f.id)).capabilities.uploadCancellation).toBe(true);
    const res = await uploadCancellation(f);
    expect(res.status).toBe(201);
    const { id } = await readJson(res, DocumentView);
    expect(
      await codesOf(
        await review(id, backOffice, { signatures: { participant: "2026-01-05" } }),
        422,
      ),
    ).toEqual(["/dsv/signatures:cancellation_signatures_missing"]);
    expect(
      await codesOf(
        await review(id, backOffice, { signatures: all("2026-01-05"), termsConfirmed: true }),
        422,
      ),
    ).toEqual(["/dsv/termsConfirmed:terms_not_applicable"]);
    expect((await review(id, backOffice, { signatures: all("2026-01-05") })).status).toBe(200);
    const view = await dsvView(f.id);
    expect(view.cancellations).toEqual([
      expect.objectContaining({
        counting: true,
        metadata: expect.objectContaining({ offerId: f.offer, signatures: all("2026-01-05") }),
      }),
    ]);
    expect(view.facts.dsvCancellation?.validOn).toBe("2026-01-05");
    // The view's other scans stay the DSV scans; the cancellation isn't one of them.
    expect(view.scans.map((s) => s.document.id)).not.toContain(id);
    expect((await detail(f.id)).dsvCancellationValidOn).toBe("2026-01-05");
  });

  it("is hidden 404, forbidden 403, then refused by state", async () => {
    const f = await signed();
    await expectProblem(await uploadCancellation({ ...f, id: randomUUID() }), 404, "not-found");
    await expectProblem(await uploadCancellation(f, consultant), 403, "forbidden");
    // Another participation's offer is not found; an open (not signed) offer is no contract.
    const other = await signed();
    await expectProblem(
      await uploadCancellation({ id: f.id, offer: other.offer }),
      404,
      "not-found",
    );
    const open = await participant();
    const offer = await externalDsvOffer(owner.$client, open);
    expect((await dsvView(open)).capabilities.uploadCancellation).toBe(false);
    await expectProblem(await uploadCancellation({ id: open, offer }), 409, "conflict");
    const { id } = await readJson(await uploadCancellation(f), DocumentView);
    await expectProblem(
      await review(id, consultant, { signatures: all("2026-01-05") }),
      404,
      "not-found",
    );
  });
});

describe("POST /participations/{id}/withdrawal", () => {
  it("withdraws a signed DSV on its cancellation with the PL's confirmation, then asks the customer notice", async () => {
    const f = await signed();
    expect((await detail(f.id)).refusals.withdraw).toBe("dsv_cancellation_missing");
    expect(await codesOf(await withdraw(f.id), 422)).toEqual([":withdrawal_after_dsv_signed"]);
    await cancelled(f);
    expect((await detail(f.id)).capabilities.withdraw).toBe(true);
    // Not without the confirmation, not dated before the cancellation, not in the future.
    expect(await codesOf(await withdraw(f.id, { confirmed: undefined }), 422)).toEqual([
      ":withdrawal_after_dsv_signed",
    ]);
    expect(await codesOf(await withdraw(f.id, { effectiveDate: "2026-01-04" }), 422)).toEqual([
      "/effectiveDate:effective_date_before_cancellation",
    ]);
    expect(await codesOf(await withdraw(f.id, { effectiveDate: await today(1) }), 422)).toEqual([
      "/effectiveDate:effective_date_in_future",
    ]);
    const res = await withdraw(f.id);
    expect(res.status).toBe(200);
    const after = await readJson(res, ParticipationDetail);
    expect(after).toMatchObject({ status: "withdrawn", dsvStatus: "dsv_signed" });
    expect(after.dates.withdrawnOn).toBe("2026-01-06");
    // "Kunde informieren" until "Kunde informiert am" is recorded (Q46).
    expect(await caseItems(f.id)).toContain("dsv_customer_notice:2026-01-06");
    expect(await caseItems(f.id, consultant).catch(() => [])).not.toContain(
      "dsv_customer_notice:2026-01-06",
    );
    const view = await dsvView(f.id);
    expect(view.customerNotice).toEqual({ dueSince: "2026-01-06", notifiedOn: null });
    expect(view.capabilities.recordCustomerNotice).toBe(true);
    expect((await dsvView(f.id, backOffice)).capabilities.recordCustomerNotice).toBe(false);
    const notify = (notifiedOn: string, as: string = projectLead) =>
      request("POST", `/participations/${f.id}/dsv/customer-notice`, as, { notifiedOn });
    await expectProblem(await notify("2026-01-07", backOffice), 403, "forbidden");
    await expectProblem(await notify("2026-01-07", consultant), 403, "forbidden");
    await expectProblem(
      await request("POST", `/participations/${randomUUID()}/dsv/customer-notice`, projectLead, {
        notifiedOn: "2026-01-07",
      }),
      404,
      "not-found",
    );
    expect(await codesOf(await notify("2026-01-05"), 422)).toEqual([
      "/notifiedOn:notice_before_withdrawal",
    ]);
    expect(await codesOf(await notify(await today(1)), 422)).toEqual([
      "/notifiedOn:date_in_future",
    ]);
    const recorded = await notify("2026-01-07");
    expect(recorded.status).toBe(200);
    expect((await readJson(recorded, DsvView)).customerNotice).toEqual({
      dueSince: "2026-01-06",
      notifiedOn: "2026-01-07",
    });
    expect(await codesOf(await notify("2026-01-08"), 422)).toEqual([":notice_recorded"]);
    expect(await caseItems(f.id)).not.toContain("dsv_customer_notice:2026-01-06");
    // Logs carry ids and codes only: no name, birth date or date of the paper.
    const text = logs.join("\n");
    expect(text).toMatch(/participation withdrawal/);
    expect(text).not.toMatch(/Zofia|Synthetik-Aufhebung|2051-07-29|2026-01-0[5-7]|aufhebung\.pdf/);
  });

  it("is refused the day after the planned start: the entry clarification is then open (D28)", async () => {
    const f = await signed();
    await cancelled(f);
    await sql(
      "update participation set offer_deadline = berlin_today() - 20, tg_start = berlin_today() - 1 where id = $1",
      [f.id],
    );
    expect((await detail(f.id)).refusals.withdraw).toBe("after_planned_start");
    expect(await codesOf(await withdraw(f.id), 422)).toEqual([":after_planned_start"]);
    expect(await caseItems(f.id)).toContain(`entry_clarification:${await today(0)}`);
    expect((await detail(f.id)).status).toBe("informed");
  });

  it("withdraws without a DSV by the PL with a pre-TG reason; never a consultant or back office", async () => {
    const id = await participant();
    await expectProblem(await withdraw(id, {}, consultant), 403, "forbidden");
    await expectProblem(await withdraw(id, {}, backOffice), 403, "forbidden");
    await expectProblem(
      await request("POST", `/participations/${randomUUID()}/withdrawal`, projectLead, {
        endReason: "placed_direct",
        effectiveDate: "2026-01-06",
        statusVersion: 0,
      }),
      404,
      "not-found",
    );
    expect(await codesOf(await withdraw(id, { endReason: "placed_permanent" }), 422)).toEqual([
      "/endReason:reason_wrong_phase",
    ]);
    expect(
      await codesOf(
        await withdraw(id, { endReason: "long_term_illness_reduced_earning_capacity" }),
        422,
      ),
    ).toEqual(["/endReason:reason_wrong_phase"]);
    await expectProblem(await withdraw(id, { statusVersion: 0 }), 409, "conflict");
    // The PL's confirmation is asked only of a signed DSV; the date has no default.
    const missing = await request("POST", `/participations/${id}/withdrawal`, projectLead, {
      endReason: "placed_direct",
      statusVersion: (await detail(id)).statusVersion,
    });
    expect(missing.status).toBe(400);
    const res = await withdraw(id, { confirmed: undefined });
    expect(res.status).toBe(200);
    expect((await readJson(res, ParticipationDetail)).status).toBe("withdrawn");
    expect((await detail(id)).refusals.withdraw).toBe("status_not_withdrawable");
  });

  it("refuses the regional operations manager, who doesn't withdraw", async () => {
    const id = await participant();
    const res = await withdraw(id, {}, regionalOperationsManager);
    expect([403, 404]).toContain(res.status);
  });
});

async function systemWithdrawn() {
  const id = await participant();
  await changeStatus(owner.$client, id, {
    field: "status",
    from: "informed",
    to: "withdrawn",
    context: nightly,
    endReason: "no_response",
    effectiveDate: "2026-01-10",
  });
  return id;
}
const correct = (id: string, body: Record<string, unknown>, as: string = projectLead) =>
  request("PUT", `/participations/${id}/end-reason`, as, body);

describe("PUT /participations/{id}/end-reason (Q72)", () => {
  it("corrects the system's reason against the reason read; the derived one becomes secondary", async () => {
    const id = await systemWithdrawn();
    const seen = await detail(id);
    expect(seen).toMatchObject({
      endReason: "no_response",
      endReasonSource: "system",
      capabilities: { correctEndReason: true, withdraw: false },
    });
    expect(
      await codesOf(await correct(id, { endReason: "placed_direct", expected: "retirement" }), 409),
    ).toEqual([":stale_value"]);
    expect(
      await codesOf(await correct(id, { endReason: "no_response", expected: "no_response" }), 422),
    ).toEqual(["/endReason:reason_unchanged"]);
    expect(
      await codesOf(
        await correct(id, { endReason: "placed_permanent", expected: "no_response" }),
        422,
      ),
    ).toEqual(["/endReason:reason_wrong_phase"]);
    const res = await correct(id, { endReason: "placed_direct", expected: "no_response" });
    expect(res.status).toBe(200);
    expect(await readJson(res, ParticipationDetail)).toMatchObject({
      status: "withdrawn",
      endReason: "placed_direct",
      endReasonSource: "user",
    });
    const { rows } = await sql(
      "select end_reason_secondary::text[] as secondary from participation where id = $1",
      [id],
    );
    expect(rows[0].secondary).toEqual(["no_response"]);
  });

  it("is the PL's: back office and a consultant 403 (and see no reason), an unknown participation 404", async () => {
    const id = await systemWithdrawn();
    for (const as of [backOffice, consultant]) {
      await expectProblem(
        await correct(id, { endReason: "placed_direct", expected: "no_response" }, as),
        403,
        "forbidden",
      );
    }
    const seen = await detail(id, backOffice);
    expect(seen.endReason).toBeUndefined();
    expect(seen.capabilities.correctEndReason).toBe(false);
    await expectProblem(
      await correct(randomUUID(), { endReason: "placed_direct", expected: "no_response" }),
      404,
      "not-found",
    );
  });

  it("is refused while no end reason is recorded", async () => {
    const id = await participant();
    expect((await detail(id)).capabilities.correctEndReason).toBe(false);
    expect(
      await codesOf(
        await correct(id, { endReason: "placed_direct", expected: "no_response" }),
        422,
      ),
    ).toEqual([":no_end_reason"]);
  });
});
