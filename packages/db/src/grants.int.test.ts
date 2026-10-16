import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import { auditContext, call, createWave, pl, resetTestDatabase, testDatabaseUrls } from "./testing";

// AC-13: the runtime role only has the grants that migrations give it explicitly.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const staffUserId = seedStaffUserIds.projectLead;

const insertProject = (client: Client) =>
  client.query(
    "insert into project (name, customer_name, type, created_by) values ($1, $2, 'ta_only', $3) returning id",
    ["Grant-Test", "Beispiel GmbH", staffUserId],
  );

const permissionDenied = { code: "42501" };

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true }));

describe("transfer_app", () => {
  it("may select projects and memberships, and creates projects only through create_project (AC-1)", async () => {
    await expect(insertProject(app)).rejects.toMatchObject(permissionDenied);
    const id = await call(app, "create_project", {
      name: "Grant-Test",
      customerName: "Beispiel GmbH",
      type: "ta_only",
      context: auditContext({ actorType: "user", staffUserId }),
    });
    const selected = await app.query("select name, status from project where id = $1", [id]);
    expect(selected.rows).toEqual([{ name: "Grant-Test", status: "draft" }]);
    const members = await app.query(
      "select staff_user_id, role from project_membership where project_id = $1",
      [id],
    );
    expect(members.rows).toEqual([{ staff_user_id: staffUserId, role: "project_lead" }]);
  });

  it("may select staff users", async () => {
    const { rowCount } = await app.query("select id from staff_user");
    expect(rowCount).toBe(6);
  });

  it.each([
    [
      "insert into project",
      `insert into project (name, customer_name, type, created_by) values ('x', 'x', 'ta_only', '${staffUserId}')`,
    ],
    ["update project", "update project set name = 'x'"],
    ["update project status", "update project set status = 'active'"],
    ["delete from project", "delete from project"],
    ["truncate project", "truncate project"],
    [
      "insert into staff_user",
      "insert into staff_user (display_name, email, role) values ('x', 'x@example.org', 'admin')",
    ],
    ["update staff_user", "update staff_user set display_name = 'x'"],
    [
      "insert into project_membership",
      `insert into project_membership (project_id, staff_user_id, role) values ('${seedProjectIds.verwaltung}', '${seedStaffUserIds.admin}', 'project_lead')`,
    ],
    ["update project_membership", "update project_membership set role = 'project_lead'"],
    ["delete from project_membership", "delete from project_membership"],
    ["truncate project_membership", "truncate project_membership"],
    ["delete from staff_user", "delete from staff_user"],
    ["create table", "create table intruder (id int)"],
    ["create schema", "create schema intruder"],
  ])("may not %s", async (_label, sql) => {
    await expect(app.query(sql)).rejects.toMatchObject(permissionDenied);
  });

  it("cannot run migrations; only transfer_owner can", async () => {
    await expect(runMigrations(urls.app)).rejects.toMatchObject({ cause: permissionDenied });
  });
});

// AC-15 (plan 5.4, D2): statuses and audit events are written only by the status functions.
const statusFunctions = [
  "lock_participation",
  "create_participation",
  "change_participation_status",
  "assign_entry_wave",
  "request_profiling_exception",
  "decide_profiling_exception",
  "revoke_profiling_exception",
  "correct_end_reason",
  "record_audit_event",
  // Slice 2 (PR 2a): the project lock and the project setup functions
  "lock_project_setup",
  "create_project",
  "update_project",
];
const helpers = [
  "assert_context",
  "write_audit_event",
  "end_reason_fits",
  "lock_current_request",
  "profiling_exception_request_progresses",
  "project_lock_key",
  "project_text_valid",
];

/** Every direct write to a table; `column` is set to itself. */
const writes = (table: string, column: string, insert: string) => [
  [`insert into ${table}`, insert],
  [`update ${table}`, `update ${table} set ${column} = ${column}`],
  [`delete from ${table}`, `delete from ${table}`],
  [`truncate ${table}`, `truncate ${table}`],
];

describe("transfer_app and the Slice 1 tables (AC-15)", () => {
  let participationId: string;
  let waveId: string;
  beforeEach(async () => {
    waveId = await createWave(owner);
    participationId = await call(app, "create_participation", {
      projectId: seedProjectIds.werkNord,
      context: pl,
    });
  });

  it("may select participations, exception requests and waves, nothing from the audit trail or the edges", async () => {
    expect((await app.query("select status from participation")).rows).toEqual([
      { status: "imported" },
    ]);
    expect((await app.query("select code from project_entry_wave order by code")).rows).toEqual([
      { code: "T1" },
      { code: "W1" },
      { code: "W2" },
    ]);
    expect((await app.query("select id from profiling_exception_request")).rows).toEqual([]);
    await expect(app.query("select * from audit_event")).rejects.toMatchObject(permissionDenied);
    await expect(app.query("select * from lifecycle_edge")).rejects.toMatchObject(permissionDenied);
  });

  it.each([
    ...writes(
      "participation",
      "id",
      `insert into participation (project_id, status, profiling_status, dsv_status) values ('${seedProjectIds.werkNord}', 'imported', 'not_started', 'not_offered')`,
    ),
    ["update participation status", "update participation set status = 'contacted'"],
    ...writes(
      "profiling_exception_request",
      "id",
      `insert into profiling_exception_request (project_id, participation_id, reason_code, status, requested_by, requested_on, evidence_record_id, evidence_fingerprint) select project_id, id, 'force_majeure', 'requested', '${seedStaffUserIds.projectLead}', '2027-02-01', gen_random_uuid(), 'sha256:v1:${"0".repeat(64)}' from participation`,
    ),
    ...writes(
      "project_entry_wave",
      "id",
      `insert into project_entry_wave (project_id, code, name) values ('${seedProjectIds.werkNord}', 'W9', 'W9')`,
    ),
    ...writes(
      "audit_event",
      "id",
      `insert into audit_event (project_id, event_type, actor_type, system_job) values ('${seedProjectIds.werkNord}', 'export_created', 'system', 'x')`,
    ),
    ...writes(
      "lifecycle_edge",
      "kind",
      "insert into lifecycle_edge (track, from_value, to_value, kind, actors) values ('main', 'withdrawn', 'imported', 'manual', '{user}')",
    ),
    ["lock participations directly", "select id from participation for update"],
    [
      "lock participations with FOR NO KEY UPDATE",
      "select id from participation for no key update",
    ],
    ["call an internal helper", `select end_reason_fits('withdrawn', 'other')`],
  ])("may not %s (42501)", async (_label, sql) => {
    await expect(app.query(sql)).rejects.toMatchObject(permissionDenied);
  });

  it("may execute the status and setup functions, and locks through lock_participation", async () => {
    await app.query("begin");
    const { rows } = await app.query("select status, status_version from lock_participation($1)", [
      participationId,
    ]);
    expect(rows).toEqual([{ status: "imported", status_version: 0 }]);
    await app.query("rollback");
    await call(app, "assign_entry_wave", { id: participationId, waveId, context: pl });
    const { rows: granted } = await owner.query(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('transfer_app', p.oid, 'execute')
       order by p.proname`,
    );
    expect(granted.map((r) => r.proname)).toEqual(statusFunctions.toSorted());
  });

  it("gives PUBLIC no EXECUTE on any function in public", async () => {
    const { rows } = await owner.query(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
         aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where n.nspname = 'public' and a.grantee = 0 and a.privilege_type = 'EXECUTE'`,
    );
    expect(rows).toEqual([]);
  });

  it("makes every function SECURITY DEFINER where granted, with a fixed search_path and no dynamic SQL", async () => {
    const { rows } = await owner.query(
      `select p.proname, p.prosecdef, p.proconfig, r.rolname, p.prosrc
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
       where n.nspname = 'public' order by p.proname`,
    );
    expect(rows.map((r) => r.proname).toSorted()).toEqual(
      [...statusFunctions, ...helpers].toSorted(),
    );
    for (const row of rows) {
      expect(row.rolname).toBe("transfer_owner");
      expect(row.prosecdef).toBe(statusFunctions.includes(row.proname));
      expect(row.proconfig).toEqual(["search_path=pg_catalog, public, pg_temp"]);
      expect(row.prosrc).not.toMatch(/\bexecute\b|\bformat\s*\(/i);
    }
  });

  it("can't shadow a table with a temporary one", async () => {
    await app.query("create temporary table participation (id uuid, status text)");
    try {
      await app.query("begin");
      const { rows } = await app.query("select status from lock_participation($1)", [
        participationId,
      ]);
      expect(rows).toEqual([{ status: "imported" }]);
      await app.query("rollback");
    } finally {
      await app.query("drop table pg_temp.participation");
    }
  });
});

/** A past run day: completion is database time, never before the scheduled run (round 19). */
const insertRun = (client: Client, runDate = "2025-04-01") =>
  client.query(
    "insert into job_run (job_name, run_date, scheduled_at) values ('lifecycle.sweep', $1, $2)",
    [runDate, `${runDate}T02:15:00Z`],
  );

// Plan 5.4 grants, 5.10, round 19: one row per job and run day, written once and never changed.
describe("transfer_app and job_run (PR 1h-1)", () => {
  it("may insert and select runs; the database records the completion", async () => {
    await insertRun(app);
    const { rows } = await app.query(
      `select job_name, run_date::text, scheduled_at,
         completed_at > scheduled_at and completed_at <= now() as completed_by_database
       from job_run`,
    );
    expect(rows).toEqual([
      {
        job_name: "lifecycle.sweep",
        run_date: "2025-04-01",
        scheduled_at: new Date("2025-04-01T02:15:00Z"),
        completed_by_database: true,
      },
    ]);
  });

  it("may not state the completion itself (42501): database time is authoritative", async () => {
    await expect(
      app.query(
        "insert into job_run (job_name, run_date, scheduled_at, completed_at) values ('lifecycle.sweep', '2025-04-01', '2025-04-01T02:15:00Z', '2025-04-01T02:20:00Z')",
      ),
    ).rejects.toMatchObject(permissionDenied);
  });

  it("can't store a completion before the scheduled run (23514)", async () => {
    // The runtime role's completion is now(), before a run scheduled in the future.
    await expect(insertRun(app, "2091-04-01")).rejects.toMatchObject({ code: "23514" });
    // Not even the owner, who may state the completion.
    await expect(
      owner.query(
        "insert into job_run (job_name, run_date, scheduled_at, completed_at) values ('lifecycle.sweep', '2025-04-01', '2025-04-01T02:15:00Z', '2025-04-01T02:14:59Z')",
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps one row per job and run day", async () => {
    await insertRun(app);
    await expect(insertRun(app)).rejects.toMatchObject({ code: "23505" });
  });

  it.each([
    [
      "a job name that is not a name",
      "insert into job_run (job_name, run_date, scheduled_at) values ('Lifecycle sweep', '2025-04-01', '2025-04-01T02:15:00Z')",
    ],
    [
      "a scheduled time on another Berlin day",
      "insert into job_run (job_name, run_date, scheduled_at) values ('lifecycle.sweep', '2025-04-01', '2025-03-31T21:59:00Z')",
    ],
  ])("refuses %s (23514)", async (_label, sql) => {
    await expect(app.query(sql)).rejects.toMatchObject({ code: "23514" });
  });

  it.each(writes("job_run", "run_date", "").slice(1))("may not %s (42501)", async (_label, sql) => {
    await insertRun(owner);
    await expect(app.query(sql)).rejects.toMatchObject(permissionDenied);
  });
});
