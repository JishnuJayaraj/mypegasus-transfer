import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  auditContext,
  call,
  informedParticipation,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "./testing";

// ADR-0002, the retention role: `transfer_retention` executes the retention functions only and
// touches no table; `transfer_app` executes none of them; the immutability triggers let a write
// through only inside a retention run this transaction opened.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const retention = new Client({ connectionString: urls.retention });
const permissionDenied = { code: "42501" };
const backOffice = auditContext({ actorType: "user", staffUserId: seedStaffUserIds.backOffice });
const today = "2026-02-01";

const retentionCalls = [
  ["retention_open_run", `select retention_open_run('${today}', true)`],
  ["retention_close_run", "select retention_close_run(gen_random_uuid(), '{}')"],
  [
    "retention_purge_credentials",
    `select retention_purge_credentials(gen_random_uuid(), '${today}')`,
  ],
  ["retention_working_copies", "select * from retention_working_copies(gen_random_uuid())"],
  [
    "retention_purge_working_copy",
    "select retention_purge_working_copy(gen_random_uuid(), gen_random_uuid())",
  ],
  ["retention_known_objects", "select retention_known_objects(gen_random_uuid(), '{}')"],
] as const;

beforeAll(() => Promise.all([app.connect(), owner.connect(), retention.connect()]));
afterAll(() => Promise.all([app.end(), owner.end(), retention.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

async function anAuditEvent(): Promise<string> {
  const participation = await informedParticipation(app);
  const { rows } = await owner.query(
    "select id from audit_event where participation_id = $1 limit 1",
    [participation],
  );
  return rows[0].id;
}

describe("transfer_app and the retention functions", () => {
  it.each(retentionCalls)("may not execute %s", async (_name, sql) => {
    await expect(app.query(sql)).rejects.toMatchObject(permissionDenied);
  });

  it("may not delete or change an audit event, nor read a run", async () => {
    await anAuditEvent();
    await expect(app.query("delete from audit_event")).rejects.toMatchObject(permissionDenied);
    await expect(app.query("update audit_event set reason_code = 'x'")).rejects.toMatchObject(
      permissionDenied,
    );
    await expect(app.query("select * from retention_run")).rejects.toMatchObject(permissionDenied);
    await expect(app.query("select in_retention_run()")).rejects.toMatchObject(permissionDenied);
  });
});

describe("transfer_retention", () => {
  it.each([
    ["select from participation", "select * from participation"],
    ["select from audit_event", "select * from audit_event"],
    ["select from retention_run", "select * from retention_run"],
    ["delete from audit_event", "delete from audit_event"],
    ["delete from staff_session", "delete from staff_session"],
    ["update document", "update document set file_name = null"],
    [
      "insert into retention_run",
      "insert into retention_run (id, run_day, dry_run, opened_txid) values (gen_random_uuid(), now(), false, 1)",
    ],
    [
      "execute record_audit_event",
      `select record_audit_event('${seedProjectIds.werkNord}', null, 'export_created', ${"null"})`,
    ],
    ["execute lock_participation", "select lock_participation(gen_random_uuid())"],
    [
      "execute set_funding_status",
      "select set_funding_status(null, gen_random_uuid(), 'known_no', 'x', 'unknown', null)",
    ],
    ["execute the trigger path's check", "select in_retention_run()"],
  ])("may not %s", async (_label, sql) => {
    await expect(retention.query(sql)).rejects.toMatchObject(permissionDenied);
  });

  it("is the only role that may open a run, and only for a day that has come", async () => {
    await expect(owner.query(`select retention_open_run('${today}', true)`)).rejects.toMatchObject({
      message: "retention_role_required",
    });
    await expect(
      retention.query("select retention_open_run(current_date + 2, true)"),
    ).rejects.toMatchObject({
      message: "run_not_due",
    });
  });

  it("opens, closes and records a run without a subject; one per transaction", async () => {
    await retention.query("begin");
    const { rows } = await retention.query(`select retention_open_run('${today}', true) as id`);
    await expect(
      retention.query(`select retention_open_run('${today}', true)`),
    ).rejects.toMatchObject({
      message: "run_open",
    });
    await retention.query("rollback");
    await retention.query("begin");
    const run = (await retention.query(`select retention_open_run('${today}', true) as id`)).rows[0]
      .id;
    await retention.query("select retention_close_run($1, $2)", [
      run,
      { access_credential: { outcome: "dry_run" } },
    ]);
    await retention.query("commit");
    const stored = await owner.query(
      "select run_day::text, dry_run, closed_at is not null as closed, summary from retention_run",
    );
    expect(stored.rows).toEqual([
      {
        run_day: today,
        dry_run: true,
        closed: true,
        summary: { access_credential: { outcome: "dry_run" } },
      },
    ]);
    expect(rows[0].id).not.toBe(run);
  });

  it("can't use a run outside the transaction that opened it", async () => {
    const run = await retention
      .query("begin")
      .then(() => retention.query(`select retention_open_run('${today}', false) as id`));
    await retention.query("commit");
    await expect(
      retention.query("select retention_close_run($1, '{}')", [run.rows[0].id]),
    ).rejects.toMatchObject({ message: "run_not_open" });
  });
});

describe("the immutability triggers' retention path", () => {
  // A stand-in for a retention function that deletes an audit event: the owner's, executable by
  // the retention role only for this test.
  beforeEach(async () => {
    await owner.query(`create or replace function test_delete_audit_event(p_id uuid) returns integer
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare n integer; begin delete from public.audit_event where id = p_id;
      get diagnostics n = row_count; return n; end $$`);
    await owner.query("revoke all on function test_delete_audit_event from public");
    await owner.query("grant execute on function test_delete_audit_event to transfer_retention");
  });
  afterAll(() => owner.query("drop function if exists test_delete_audit_event"));

  it("refuses the owner, and the role without an open run", async () => {
    const event = await anAuditEvent();
    await expect(
      owner.query("delete from audit_event where id = $1", [event]),
    ).rejects.toMatchObject({
      message: "audit_append_only",
    });
    await expect(
      owner.query("update staff_audit_event set reason_code = reason_code"),
    ).resolves.toBeDefined();
    await expect(
      retention.query("select test_delete_audit_event($1)", [event]),
    ).rejects.toMatchObject({
      message: "audit_append_only",
    });
  });

  it("refuses the setting alone: a run of another transaction, or a closed one", async () => {
    const event = await anAuditEvent();
    await retention.query("begin");
    const run = (await retention.query(`select retention_open_run('${today}', false) as id`))
      .rows[0].id;
    await retention.query("commit");
    await retention.query("begin");
    await retention.query("select set_config('transfer.retention_run', $1, true)", [run]);
    await expect(
      retention.query("select test_delete_audit_event($1)", [event]),
    ).rejects.toMatchObject({
      message: "audit_append_only",
    });
    await retention.query("rollback");
    // The setting on the owner's session changes nothing either.
    await owner.query("begin");
    await owner.query("select set_config('transfer.retention_run', $1, true)", [run]);
    await expect(
      owner.query("delete from audit_event where id = $1", [event]),
    ).rejects.toMatchObject({
      message: "audit_append_only",
    });
    await owner.query("rollback");
  });

  it("lets the write through inside the run this transaction opened, and not after it closed", async () => {
    const event = await anAuditEvent();
    const other = await anAuditEvent();
    await retention.query("begin");
    const run = (await retention.query(`select retention_open_run('${today}', false) as id`))
      .rows[0].id;
    expect(
      (await retention.query("select test_delete_audit_event($1) as n", [event])).rows[0].n,
    ).toBe(1);
    await retention.query("select retention_close_run($1, '{}')", [run]);
    await expect(
      retention.query("select test_delete_audit_event($1)", [other]),
    ).rejects.toMatchObject({
      message: "audit_append_only",
    });
    await retention.query("rollback");
  });

  it.each([
    ["privacy_notice_delivery", "privacy_notice_immutable"],
    ["evidence_correction", "correction_immutable"],
    ["ba_reporting_task", "task_immutable"],
    ["project_template_pin", "append_only"],
  ])("keeps %s refusing outside a run", async (table, code) => {
    // The audit trail's path is exercised above; every other immutability trigger shares it.
    const { rows } = await owner.query(
      `select p.proname from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = $1::regclass and not t.tgisinternal`,
      [table],
    );
    expect(rows.length).toBeGreaterThan(0);
    const body = await owner.query("select prosrc from pg_proc where proname = $1", [
      rows[0].proname,
    ]);
    expect(body.rows[0].prosrc).toContain("in_retention_run()");
    expect(body.rows[0].prosrc).toContain(code);
  });
});

describe("settlement dates and funding (Q52, Q217)", () => {
  const settle = (context: string, kug: string | null, expected: string | null = null) =>
    call(owner, "set_settlement_dates", {
      context,
      projectId: seedProjectIds.werkNord,
      kugFinal: kug,
      measure110: null,
      expectedKugFinal: expected,
      expectedMeasure110: null,
    });

  it("lets back office set the dates against the values read, never the PL", async () => {
    await expect(settle(pl, "2027-06-30")).rejects.toMatchObject({ message: "actor_not_allowed" });
    await settle(backOffice, "2027-06-30");
    await expect(settle(backOffice, "2027-07-31")).rejects.toMatchObject({
      message: "stale_settlement_dates",
    });
    await expect(settle(backOffice, "2027-06-30", "2027-06-30")).rejects.toMatchObject({
      message: "project_unchanged",
    });
    await settle(backOffice, null, "2027-06-30");
    const events = await owner.query(
      "select participation_id, details from audit_event where event_type = 'settlement_dates_set' order by seq",
    );
    expect(events.rows).toEqual([
      { participation_id: null, details: { fields: ["kugFinalSettlementDate"] } },
      { participation_id: null, details: { fields: ["kugFinalSettlementDate"] } },
    ]);
  });

  it("lets back office record the funding with its source, against the value read", async () => {
    const id = await informedParticipation(app);
    const fund = (
      context: string,
      value: string,
      source: string,
      expected: string,
      expectedSource: string | null,
    ) =>
      call(owner, "set_funding_status", {
        context,
        participationId: id,
        funded110: value,
        source,
        expectedFunded110: expected,
        expectedSource,
      });
    await expect(fund(pl, "known_yes", "Bescheid 1", "unknown", null)).rejects.toMatchObject({
      message: "actor_not_allowed",
    });
    await expect(fund(backOffice, "known_yes", " ", "unknown", null)).rejects.toMatchObject({
      message: "invalid_argument",
    });
    await fund(backOffice, "known_yes", "Bescheid 1", "unknown", null);
    await expect(fund(backOffice, "known_no", "Bescheid 2", "unknown", null)).rejects.toMatchObject(
      {
        message: "stale_funding",
      },
    );
    await expect(
      fund(backOffice, "known_yes", "Bescheid 1", "known_yes", "Bescheid 1"),
    ).rejects.toMatchObject({
      message: "funding_unchanged",
    });
    const stored = await owner.query(
      "select funded110, funded110_source, funded110_set_by from participation where id = $1",
      [id],
    );
    expect(stored.rows).toEqual([
      {
        funded110: "known_yes",
        funded110_source: "Bescheid 1",
        funded110_set_by: seedStaffUserIds.backOffice,
      },
    ]);
    const events = await owner.query(
      "select details from audit_event where event_type = 'funding_status_set' and participation_id = $1",
      [id],
    );
    expect(events.rows).toEqual([{ details: { funded110: "known_yes" } }]);
  });

  it("refuses both event types through record_audit_event", async () => {
    for (const type of ["settlement_dates_set", "funding_status_set"]) {
      await expect(
        call(app, "record_audit_event", {
          projectId: seedProjectIds.werkNord,
          participationId: null,
          eventType: type,
          context: pl,
        }),
      ).rejects.toMatchObject({ message: "event_type_reserved" });
    }
  });
});
