import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  call,
  changeStatus,
  createWave,
  informedParticipation,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
  textDates,
} from "./testing";

// Slice 2 plan 5.3, 5.7 (PR 2h-3; R38, R41, R42; round 33; AC-37, AC-40, AC-47, AC-48):
// `set_participation_dates` writes the dates, the amendment, the BA tasks and the audit event
// together or not at all; amendments are immutable, tasks only move forward, an early exit
// creates its task.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner, types: textDates });

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const failsWith = (code: string) => ({ code: "P0001", message: code });
const row = async (id: string) =>
  (await owner.query("select * from participation where id = $1", [id])).rows[0];
const tasks = async (id: string) =>
  (
    await owner.query(
      `select reporting_kind, subject_date, amendment_id, status from ba_reporting_task
       where participation_id = $1 order by created_at, reporting_kind`,
      [id],
    )
  ).rows;
const amendments = async (id: string) =>
  (await owner.query("select * from participation_dsv_amendment where participation_id = $1", [id]))
    .rows;
const dateEvents = async (id: string) =>
  (
    await owner.query(
      `select details from audit_event
       where participation_id = $1 and event_type = 'participation_dates_changed' order by seq`,
      [id],
    )
  ).rows.map((r) => r.details);

/** Informed with wave T1 (start 01.03.2027, end 29.02.2028, latest entry 15.03.2027). */
let waves = 0;
async function withWave() {
  waves += 1;
  const entryWaveId = await createWave(owner, seedProjectIds.werkNord, `T${waves}`);
  return informedParticipation(app, { entryWaveId });
}
async function signed() {
  const id = await withWave();
  await changeStatus(app, id, { field: "dsv_status", from: "not_offered", to: "dsv_offered" });
  await changeStatus(app, id, { field: "dsv_status", from: "dsv_offered", to: "dsv_signed" });
  return id;
}
const amendment = (kind: "extension" | "new_start", extra: object = {}) => ({
  amendmentKind: kind,
  amendmentFullyExecutedOn: "2027-02-20",
  amendmentOriginalLocation: "paper_personnel_file",
  amendmentConfirmed: true,
  ...extra,
});
const setDates = async (id: string, dates: object, extra: object = {}) =>
  call(app, "set_participation_dates", {
    id,
    tgStart: null,
    tgEnd: null,
    expectedVersion: (await row(id)).status_version,
    context: pl,
    ...dates,
    ...extra,
  });

describe("set_participation_dates (AC-37, AC-48)", () => {
  it("changes the end before signature: version, task and event, no amendment", async () => {
    const id = await withWave();
    const version = (await row(id)).status_version;
    await setDates(id, { tgEnd: "2028-01-31" });
    expect(await row(id)).toMatchObject({
      tg_start: null,
      tg_end: "2028-01-31",
      status_version: version + 1,
    });
    expect(await tasks(id)).toEqual([
      {
        reporting_kind: "planned_end_changed",
        subject_date: "2028-01-31",
        amendment_id: null,
        status: "pending",
      },
    ]);
    expect(await amendments(id)).toEqual([]);
    expect(await dateEvents(id)).toEqual([
      { oldTgEnd: "2028-02-29", newTgEnd: "2028-01-31", reportingKinds: ["planned_end_changed"] },
    ]);
  });

  it("records a new start of a signed DSV with its amendment, linked from the task", async () => {
    const id = await signed();
    await setDates(
      id,
      { tgStart: "2027-03-10" },
      amendment("new_start", {
        amendmentDocumentReference: "DSV-2027/0001",
      }),
    );
    const [recorded] = await amendments(id);
    expect(recorded).toMatchObject({
      kind: "new_start",
      fully_executed_on: "2027-02-20",
      old_tg_start: "2027-03-01",
      new_tg_start: "2027-03-10",
      old_tg_end: "2028-02-29",
      new_tg_end: "2028-02-29",
      confirmed_by: seedStaffUserIds.projectLead,
      original_location: "paper_personnel_file",
      document_reference: "DSV-2027/0001",
    });
    expect(await tasks(id)).toEqual([
      expect.objectContaining({
        reporting_kind: "later_entry",
        subject_date: "2027-03-10",
        amendment_id: recorded.id,
      }),
    ]);
    expect(await dateEvents(id)).toEqual([
      {
        oldTgStart: "2027-03-01",
        newTgStart: "2027-03-10",
        amendmentId: recorded.id,
        reportingKinds: ["later_entry"],
      },
    ]);
  });

  it("creates one task per changed date for a change of both", async () => {
    const id = await withWave();
    await setDates(id, { tgStart: "2027-03-05", tgEnd: "2028-03-04" });
    expect((await tasks(id)).map((t) => [t.reporting_kind, t.subject_date])).toEqual([
      ["later_entry", "2027-03-05"],
      ["planned_end_changed", "2028-03-04"],
    ]);
  });

  it.each([
    ["no amendment once the DSV is signed", true, {}, "dsv_amendment_required"],
    ["an amendment before signature", false, amendment("extension"), "amendment_not_allowed"],
    ["the wrong kind of amendment", true, amendment("extension"), "amendment_kind_mismatch"],
    ["half an amendment", true, { amendmentKind: "new_start" }, "invalid_argument"],
    [
      "an unconfirmed amendment",
      true,
      amendment("new_start", { amendmentConfirmed: false }),
      "invalid_argument",
    ],
  ])("refuses %s and writes nothing", async (_label, isSigned, extra, code) => {
    const id = isSigned ? await signed() : await withWave();
    const before = await row(id);
    await expect(setDates(id, { tgStart: "2027-03-10" }, extra)).rejects.toMatchObject(
      failsWith(code),
    );
    expect(await row(id)).toEqual(before);
    expect(await tasks(id)).toEqual([]);
    expect(await amendments(id)).toEqual([]);
  });

  it("refuses a stale version, an unchanged date, an open offer and a closed or waveless participation", async () => {
    const id = await withWave();
    await expect(
      setDates(id, { tgEnd: "2028-01-31" }, { expectedVersion: 99 }),
    ).rejects.toMatchObject(failsWith("stale_status"));
    await expect(setDates(id, { tgEnd: "2028-02-29" })).rejects.toMatchObject(
      failsWith("dates_unchanged"),
    );
    await changeStatus(app, id, { field: "dsv_status", from: "not_offered", to: "dsv_offered" });
    await expect(setDates(id, { tgEnd: "2028-01-31" })).rejects.toMatchObject(
      failsWith("dsv_offer_open"),
    );
    const waveless = await informedParticipation(app);
    await expect(setDates(waveless, { tgEnd: "2028-01-31" })).rejects.toMatchObject(
      failsWith("wave_required"),
    );
    const other = await call(app, "create_participation", {
      projectId: seedProjectIds.verwaltung,
      context: pl,
    });
    await expect(setDates(other, { tgEnd: "2028-01-31" })).rejects.toMatchObject(
      failsWith("not_ta_tg"),
    );
    const closed = await withWave();
    await changeStatus(app, closed, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: "2027-02-01",
    });
    await expect(setDates(closed, { tgEnd: "2028-01-31" })).rejects.toMatchObject(
      failsWith("participation_closed"),
    );
  });

  it("refuses a new start after TG entry", async () => {
    const id = await signed();
    await changeStatus(app, id, {
      field: "status",
      from: "informed",
      to: "active_in_tg",
      entryKind: "reconciliation",
      effectiveDate: "2027-03-01",
    });
    await expect(
      setDates(id, { tgStart: "2027-03-10" }, amendment("new_start")),
    ).rejects.toMatchObject(failsWith("entered"));
  });

  it("rolls the dates back when the amendment can't be stored: all or nothing (round 33)", async () => {
    const id = await signed();
    const before = await row(id);
    await expect(
      setDates(
        id,
        { tgStart: "2027-03-10" },
        amendment("new_start", {
          amendmentDocumentReference: "frei formulierter Text",
        }),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "participation_dsv_amendment_reference" });
    expect(await row(id)).toEqual(before);
    expect(await tasks(id)).toEqual([]);
    expect(await dateEvents(id)).toEqual([]);
  });
});

describe("immutability (R41, R42)", () => {
  it("never changes or removes an amendment; a task only moves forward and is never removed", async () => {
    const id = await signed();
    await setDates(id, { tgStart: "2027-03-10" }, amendment("new_start"));
    await expect(
      owner.query("update participation_dsv_amendment set fully_executed_on = '2027-02-21'"),
    ).rejects.toMatchObject(failsWith("append_only"));
    await expect(owner.query("delete from participation_dsv_amendment")).rejects.toMatchObject(
      failsWith("append_only"),
    );
    await expect(owner.query("delete from ba_reporting_task")).rejects.toMatchObject(
      failsWith("task_immutable"),
    );
    await expect(
      owner.query("update ba_reporting_task set subject_date = '2027-03-11'"),
    ).rejects.toMatchObject(failsWith("task_immutable"));
    await owner.query(
      "update ba_reporting_task set status = 'reported', reported_on = '2027-03-12', channel = 'x'",
    );
    await expect(
      owner.query(
        "update ba_reporting_task set status = 'pending', reported_on = null, channel = null",
      ),
    ).rejects.toMatchObject(failsWith("task_immutable"));
  });
});

/** Signed and entered on 01.03.2027 (a reconciliation, so no facts are needed). */
async function entered() {
  const id = await signed();
  await changeStatus(app, id, {
    field: "status",
    from: "informed",
    to: "active_in_tg",
    entryKind: "reconciliation",
    effectiveDate: "2027-03-01",
  });
  return id;
}
const exit = (id: string, effectiveDate: string) =>
  changeStatus(app, id, {
    field: "status",
    from: "active_in_tg",
    to: "exited",
    endReason: "placed_permanent",
    effectiveDate,
  });

describe("the early-exit task (R38, R39)", () => {
  it("is created for an exit before the contractual end", async () => {
    const id = await entered();
    await exit(id, "2027-09-30");
    expect(await tasks(id)).toEqual([
      {
        reporting_kind: "early_exit",
        subject_date: "2027-09-30",
        amendment_id: null,
        status: "pending",
      },
    ]);
  });

  it("isn't created for an exit on the contractual end (its last day)", async () => {
    const id = await entered();
    await owner.query("update participation set tg_end = '2027-09-30' where id = $1", [id]);
    await exit(id, "2027-09-30");
    expect(await tasks(id)).toEqual([]);
  });

  it("is created when there is no contractual end at all", async () => {
    const id = await entered();
    await owner.query(
      "update project_entry_wave set default_tg_end = null where id = (select entry_wave_id from participation where id = $1)",
      [id],
    );
    await exit(id, "2027-09-30");
    expect((await tasks(id)).map((t) => t.reporting_kind)).toEqual(["early_exit"]);
  });
});
