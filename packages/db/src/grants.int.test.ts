import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";
import { seedProjectIds, seedRegionIds, seedStaffUserIds } from "./seed";
import { auditContext, call, createWave, pl, resetTestDatabase, testDatabaseUrls } from "./testing";

// ADR-0002: the runtime role only has the grants that migrations give it explicitly.
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
  it("may select projects and memberships, and creates projects only through create_project", async () => {
    await expect(insertProject(app)).rejects.toMatchObject(permissionDenied);
    const id = await call(app, "create_project", {
      name: "Grant-Test",
      customerName: "Beispiel GmbH",
      type: "ta_only",
      regionId: seedRegionIds.nord,
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
      "insert into staff_user (display_name, email) values ('x', 'x@example.org')",
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

// ADR-0002: statuses and audit events are written only by the status functions.
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
  // Slice 2 (PR 2b): entry waves
  "create_entry_wave",
  "update_entry_wave",
  // Slice 2 (PR 2c-2): template pins
  "pin_agentur_template",
  // Slice 2 (PR 2d-1): override versions
  "write_project_override",
  // Slice 2 (PR 2d-2): rule relaxations
  "request_rule_relaxation",
  "decide_rule_relaxation",
  "withdraw_rule_relaxation",
  // Slice 2 (PR 2e-1): activation
  "activate_project",
  // Slice 2 (PR 2e-2): template version migration with review
  "migrate_agentur_template",
  // Slice 2 (PR 2f): person data
  "write_participant_data",
  // Slice 2 (PR 2h-3): individual TG dates with their amendment and BA reporting tasks
  "set_participation_dates",
  // Slice 3 (PR 3b): staff sessions
  "start_staff_session",
  "end_staff_session",
  "bind_staff_identity",
  "record_staff_login_refused",
  // Slice 3 (PR 3c): regions, staff accounts, org roles, teams and assignments
  "create_region",
  "update_region",
  "create_staff_user",
  "update_staff_user",
  "deactivate_staff_user",
  "grant_org_role",
  "revoke_org_role",
  "set_org_roles",
  "add_project_member",
  "remove_project_member",
  "assign_participations",
  "unassign_participation",
  // Slice 3 (PR 3d): activation codes and Art. 14 notice evidence
  "issue_activation_code",
  "record_activation_delivery",
  "hand_over_activation_code",
  "revoke_activation_code",
  "record_privacy_notice",
  // Slice 3 (PR 3e): participant activation and sessions
  "start_activation",
  "check_activation_birth_date",
  "check_activation_delivery_address",
  "create_one_time_code",
  "record_one_time_code_delivery",
  "complete_activation",
  "end_participant_session",
  "mark_activation_notice_sent",
  // Slice 3 (PR 3f): portal login, channels, lost-access recovery
  "request_login_code",
  "record_login_code_delivery",
  "start_participant_session",
  "request_channel_code",
  "add_participant_channel",
  "remove_participant_channel",
  // Slice 4a: the placement Agentur (Q139) and the self-service writes (Q138, Q140)
  "set_placement_agentur",
  "acknowledge_self_service_notice",
  "write_self_service_data",
  // Slice 4a: the encrypted fields and the step-up (Q135, Q137)
  "write_sensitive_fields",
  "read_sensitive_fields",
  "check_step_up_birth_date",
  "request_step_up_code",
  "verify_step_up_code",
  // Slice 4a: assisted mode (Q136)
  "start_assisted_mode",
  "end_assisted_mode",
  // Slice 4b: documents (data-protection.md, uploads)
  "add_document",
  "record_document_upload_rejected",
  "open_document",
  "document_link_content",
  "review_document",
  "delete_document",
  "record_document_purged",
  // Slice 5: reminders and consent v2 (data-protection.md, reminders)
  "request_reminders",
  "claim_reminder_dispatch",
  "record_reminder_outcome",
  "upgrade_channel_consent",
  // Slice 5: the audit history (data-protection.md, audit metadata)
  "audit_history",
  // Slice 5b: appointments (data-protection.md, appointments)
  "create_appointment",
  "update_appointment",
  "change_appointment_host",
  "cancel_appointment",
  "book_appointment",
  "cancel_appointment_booking",
  // Slice 5b: attendance and `informed` (data-protection.md, appointments)
  "record_attendance",
  "confirm_information_delivered",
  "escalate_attendance_conflict",
  "resolve_attendance_conflict",
  // Slice 5b: invitations, organizer notices and their follow-up (data-protection.md, messages)
  "request_invitations",
  "record_notice_follow_up",
];
const helpers = [
  "assert_context",
  "write_audit_event",
  "end_reason_fits",
  "lock_current_request",
  "profiling_exception_request_progresses",
  "project_lock_key",
  "project_text_valid",
  "entry_wave_text_valid",
  "refuse_config_change",
  "override_without_agentur",
  "override_without_relaxation",
  "override_relaxations_of",
  "append_project_override",
  "lock_relaxation_request",
  "config_relaxation_request_progresses",
  "append_template_pin",
  "scoped_setting_keys",
  "ba_reporting_task_progresses",
  "create_early_exit_task",
  "assert_global_admin",
  "is_project_lead",
  "assert_team_context",
  "staff_text_valid",
  "region_code_valid",
  "staff_email_valid",
  "lock_projects_of_staff",
  "lock_admin_survivorship",
  "assert_activation_actor",
  "keep_privacy_notice_immutable",
  "revoke_codes_at_terminal_status",
  "apply_status_change",
  "participant_context",
  "portal_system_context",
  "participant_session_live",
  "activation_code_open",
  "participation_before_cutoff",
  "activation_needs_birth_date",
  "contact_address_valid",
  "assert_channel_available",
  "lock_activating_session",
  "count_activation_failure",
  "insert_one_time_code",
  "verify_one_time_code",
  "participant_account_usable",
  "lock_active_session",
  "lock_self_service_writer",
  "keep_notice_acknowledgement_immutable",
  "sensitive_group_fields",
  "seal_sensitive_value",
  "open_sensitive_value",
  "open_sensitive_fields",
  "sensitive_value_valid",
  "participant_session_stepped_up",
  "participant_step_up_method",
  "record_step_up",
  "fail_step_up",
  "assisted_mode_roles",
  "assisted_sensitive_fields",
  "lock_assisted_mode",
  "close_assisted_mode",
  "end_assisted_modes_of_session",
  "document_staff_roles",
  "current_document_policy",
  "lock_document_actor",
  "reminder_requester_allowed",
  "reminder_job_context",
  "settle_reminder",
  "audit_history_details",
  "appointment_member_roles",
  "appointment_staff_allowed",
  "appointment_text_valid",
  "appointment_instant",
  "appointment_values_valid",
  "assert_host_free",
  "assert_appointment_audience",
  "assert_appointment_manager",
  "assert_appointment_context",
  "cancel_booking_row",
  "lock_appointment_participations",
  "cancel_bookings_at_terminal_status",
  "booking_event_details",
  "participation_closed_at",
  "booking_conflict_open",
  "confirm_informed",
  "lock_conflict_booking",
  "appointment_notice_context",
  "message_job_context",
  "appointment_booking_refusal",
  "queue_appointment_message",
  "queue_appointment_notice",
];

/** Every direct write to a table; `column` is set to itself. */
const writes = (table: string, column: string, insert: string) => [
  [`insert into ${table}`, insert],
  [`update ${table}`, `update ${table} set ${column} = ${column}`],
  [`delete from ${table}`, `delete from ${table}`],
  [`truncate ${table}`, `truncate ${table}`],
];

describe("transfer_app and the Slice 1 tables (ADR-0002)", () => {
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

// ADR-0002, template versions and pins (PR 2c-2): template versions and pins are read by the app
// and written only by pin_agentur_template.
describe("transfer_app and the template tables", () => {
  const version = `insert into config_template_version (agentur_key, version, content, content_sha256)
    values ('x', 1, '{"kind":"regional_template","agenturKey":"x","version":1}', '${"0".repeat(64)}')`;
  beforeEach(async () => {
    await owner.query(version);
    await owner.query(
      `insert into project_template_pin (project_id, agentur_key, version, pinned_by)
       values ($1, 'x', 1, $2)`,
      [seedProjectIds.werkNord, staffUserId],
    );
  });

  it("may select both", async () => {
    expect(
      (await app.query("select agentur_key, version from config_template_version")).rows,
    ).toEqual([{ agentur_key: "x", version: 1 }]);
    expect((await app.query("select agentur_key from project_template_pin")).rows).toEqual([
      { agentur_key: "x" },
    ]);
  });

  it.each([
    ...writes("config_template_version", "version", version),
    ...writes(
      "project_template_pin",
      "version",
      `insert into project_template_pin (project_id, agentur_key, version, pinned_by) values ('${seedProjectIds.lagerSued}', 'x', 1, '${staffUserId}')`,
    ),
    ["call the trigger function", "select refuse_config_change()"],
  ])("may not %s (42501)", async (_label, sql) => {
    await expect(app.query(sql)).rejects.toMatchObject(permissionDenied);
  });
});

// ADR-0002, project override versions (PR 2d-1): override versions are read by the app and written
// only by write_project_override.
describe("transfer_app and the override table", () => {
  const insert = `insert into project_config_override (project_id, version, content, created_by)
    values ('${seedProjectIds.werkNord}', 1, '{"kind":"project_override","schemaVersion":1}', '${staffUserId}')`;
  beforeEach(() => owner.query(insert));

  it("may select it", async () => {
    expect((await app.query("select version from project_config_override")).rows).toEqual([
      { version: 1 },
    ]);
  });

  it.each(writes("project_config_override", "version", insert.replace(", 1,", ", 2,")))(
    "may not %s (42501)",
    async (_label, sql) => {
      await expect(app.query(sql)).rejects.toMatchObject(permissionDenied);
    },
  );
});

// process-and-lifecycle.md, "DSV amendment" (PR 2h-3): DSV amendments and BA reporting tasks are
// read by the app and written only by set_participation_dates and the early-exit trigger.
describe("transfer_app and the amendments and BA reporting tasks", () => {
  it("may select both", async () => {
    expect((await app.query("select id from participation_dsv_amendment")).rows).toEqual([]);
    expect((await app.query("select id from ba_reporting_task")).rows).toEqual([]);
  });

  it.each([
    ...writes(
      "participation_dsv_amendment",
      "id",
      `insert into participation_dsv_amendment (participation_id, project_id, kind, fully_executed_on, confirmed_by, original_location) values (gen_random_uuid(), '${seedProjectIds.werkNord}', 'extension', '2027-01-01', '${staffUserId}', 'paper_personnel_file')`,
    ),
    ...writes(
      "ba_reporting_task",
      "id",
      `insert into ba_reporting_task (participation_id, project_id, reporting_kind, subject_date) values (gen_random_uuid(), '${seedProjectIds.werkNord}', 'early_exit', '2027-01-01')`,
    ),
  ])("may not %s (42501)", async (_label, sql) => {
    await expect(app.query(sql)).rejects.toMatchObject(permissionDenied);
  });
});

// ADR-0002, rule relaxation requests (PR 2d-2): relaxation requests are read by the app and written
// only by their functions.
describe("transfer_app and the relaxation requests", () => {
  const insert = `insert into config_relaxation_request (project_id, rule_id, reason_code, status, requested_by, requested_on)
    values ('${seedProjectIds.werkNord}', 'base-import-address', 'source_data_not_provided', 'requested', '${staffUserId}', '2026-10-17')`;
  beforeEach(() => owner.query(insert));

  it("may select them", async () => {
    expect((await app.query("select rule_id, status from config_relaxation_request")).rows).toEqual(
      [{ rule_id: "base-import-address", status: "requested" }],
    );
  });

  it.each([
    ...writes("config_relaxation_request", "status", insert.replace("address", "birthDate")),
    ["call an internal helper", "select override_without_relaxation('{}', 'x')"],
    ["lock a request", `select lock_relaxation_request(gen_random_uuid(), null)`],
  ])("may not %s (42501)", async (_label, sql) => {
    await expect(app.query(sql)).rejects.toMatchObject(permissionDenied);
  });
});

// Slice 3 (PR 3c): regions, org roles and assignments are read by the app and written only by
// their functions.
describe("transfer_app and the region, org-role and assignment tables", () => {
  it("may select them", async () => {
    expect((await app.query("select code from region order by code")).rows).toEqual([
      { code: "NORD" },
      { code: "SUED" },
    ]);
    expect((await app.query("select role from staff_org_role order by role")).rows).toHaveLength(3);
    expect((await app.query("select id from participant_assignment")).rows).toEqual([]);
  });

  it.each([
    ...writes("region", "code", "insert into region (code, name) values ('OST', 'Ost')"),
    ...writes(
      "staff_org_role",
      "role",
      `insert into staff_org_role (staff_user_id, role) values ('${staffUserId}', 'admin')`,
    ),
    ...writes(
      "participant_assignment",
      "id",
      `insert into participant_assignment (project_id, participation_id, staff_user_id, assigned_by) select project_id, id, '${seedStaffUserIds.consultant}', '${staffUserId}' from participation`,
    ),
    ["call an internal helper", `select assert_global_admin('${staffUserId}')`],
    ["lock a staff user's projects", `select lock_projects_of_staff('${staffUserId}')`],
  ])("may not %s (42501)", async (_label, sql) => {
    await expect(app.query(sql)).rejects.toMatchObject(permissionDenied);
  });
});

// Slice 3 (PR 3d): code hashes and notice evidence are readable for projections, but every write
// is confined to the hardened activation functions.
describe("transfer_app and activation evidence", () => {
  it("may select activation codes and privacy-notice deliveries", async () => {
    expect((await app.query("select id from activation_code")).rows).toEqual([]);
    expect((await app.query("select id from privacy_notice_delivery")).rows).toEqual([]);
  });

  it.each([
    ...writes(
      "activation_code",
      "id",
      `insert into activation_code
         (project_id, participation_id, code_hash, channel, notice_language, issued_by, expires_at)
       values ('${seedProjectIds.werkNord}', gen_random_uuid(), '${"a".repeat(64)}', 'letter',
         'de', '${staffUserId}', now() + interval '30 days')`,
    ),
    ...writes(
      "privacy_notice_delivery",
      "id",
      `insert into privacy_notice_delivery
         (project_id, participation_id, notice_version, language, method, provided_by)
       values ('${seedProjectIds.werkNord}', gen_random_uuid(), 'art14-activation:v1', 'de',
         'letter', '${staffUserId}')`,
    ),
    [
      "call assert_activation_actor",
      `select assert_activation_actor('${seedProjectIds.werkNord}', null)`,
    ],
    ["call notice immutability trigger", "select keep_privacy_notice_immutable()"],
    ["call terminal-code trigger", "select revoke_codes_at_terminal_status()"],
  ])("may not %s (42501)", async (_label, statement) => {
    await expect(app.query(statement)).rejects.toMatchObject(permissionDenied);
  });
});

// Slice 3 (PR 3e): accounts, channels, consents, one-time codes and participant sessions are read
// by the app and written only by the activation functions; of a session, the app may touch
// `last_seen_at` alone (ADR-0007, participant sessions).
describe("transfer_app and the participant activation tables", () => {
  it("may select them", async () => {
    for (const table of [
      "participant_account",
      "consent_record",
      "participant_channel",
      "one_time_code_challenge",
      "participant_session",
    ]) {
      expect((await app.query(`select * from ${table}`)).rows).toEqual([]);
    }
  });

  it("may update a session's last_seen_at", async () => {
    await expect(
      app.query("update participant_session set last_seen_at = now()"),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  const values = `'${seedProjectIds.werkNord}', gen_random_uuid()`;
  it.each([
    ...writes(
      "participant_account",
      "language",
      `insert into participant_account (project_id, participation_id, activation_code_id, identity_assurance, language)
       values (${values}, gen_random_uuid(), 'birth_date', 'de')`,
    ),
    ...writes(
      "consent_record",
      "language",
      `insert into consent_record (project_id, participation_id, purpose, channel_id, text_version, language, actor_type)
       values (${values}, 'portal_contact', gen_random_uuid(), 'portal-contact-consent:v1', 'de', 'participant')`,
    ),
    ...writes(
      "participant_channel",
      "notice_sent_at",
      `insert into participant_channel (project_id, participation_id, kind, address, verified_by, consent_id)
       values (${values}, 'email', 'person@example.invalid', 'one_time_code', gen_random_uuid())`,
    ),
    ...writes(
      "one_time_code_challenge",
      "failed_attempts",
      `insert into one_time_code_challenge (project_id, participation_id, purpose, kind, address, code_hash, expires_at)
       values (${values}, 'channel_verification', 'email', 'person@example.invalid', '${"a".repeat(64)}', now())`,
    ),
    [
      "insert into participant_session",
      `insert into participant_session (token_hash, project_id, participation_id, state)
       values ('${"a".repeat(64)}', ${values}, 'active')`,
    ],
    ["update a session's state", "update participant_session set state = state"],
    ["end a session", "update participant_session set ended_at = now()"],
    ["update a session's step-up", "update participant_session set step_up_at = now()"],
    [
      "step up a session itself",
      "update participant_session set sensitive_step_up_at = now(), sensitive_step_up_method = 'birth_date'",
    ],
    ["reset its step-up failures", "update participant_session set step_up_failures = 0"],
    ["delete from participant_session", "delete from participant_session"],
    ["truncate participant_session", "truncate participant_session"],
    [
      "take a status change as a participant",
      "select apply_status_change(null, null, null, null, null)",
    ],
    ["verify a one-time code directly", "select verify_one_time_code(null, null, null, null)"],
    ["count an activation failure directly", "select count_activation_failure(null, null)"],
  ])("may not %s (42501)", async (_label, statement) => {
    await expect(app.query(statement)).rejects.toMatchObject(permissionDenied);
  });
});

// ADR-0002, encryption (Q135): the app sees the encrypted tables' presence flags, key ids and
// times, never a ciphertext, writes them only through write_sensitive_fields and can't reach
// pgcrypto at all.
describe("transfer_app and the encrypted self-service tables", () => {
  const ciphertexts = {
    participant_identifier_data: ["pension_insurance_number"],
    participant_residence_social_data: [
      "nationality",
      "entry_to_germany_date",
      "residence_status",
      "buergergeld",
    ],
    participant_health_data: ["health_restrictions", "severe_disability"],
  };

  it("may select the presence flags, key ids and times", async () => {
    for (const [table, columns] of Object.entries(ciphertexts)) {
      const presence = columns.map((c) => `${c}_present`).join(", ");
      expect(
        (
          await app.query(`select participation_id, project_id, ${presence}, key_id, created_at,
           written_at from ${table}`)
        ).rows,
      ).toEqual([]);
    }
  });

  it.each(
    Object.entries(ciphertexts).flatMap(([table, columns]) => [
      [`select * from ${table}`, `select * from ${table}`],
      ...columns.map((c) => [`select ${table}.${c}`, `select ${c} from ${table}`]),
      [
        `insert into ${table}`,
        `insert into ${table} (participation_id, project_id, key_id)
         values (gen_random_uuid(), '${seedProjectIds.werkNord}', '${"a".repeat(16)}')`,
      ],
      [`update ${table}`, `update ${table} set key_id = key_id`],
      [`delete from ${table}`, `delete from ${table}`],
      [`truncate ${table}`, `truncate ${table}`],
    ]) as [string, string][],
  )("may not %s (42501)", async (_label, statement) => {
    await expect(app.query(statement)).rejects.toMatchObject(permissionDenied);
  });

  it("can't use pgcrypto, which lives in its own schema", async () => {
    await expect(
      app.query("select crypto.pgp_sym_decrypt(null::bytea, 'k')"),
    ).rejects.toMatchObject(permissionDenied);
    const { rows } = await owner.query(
      `select e.extname, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
       where e.extname = 'pgcrypto'`,
    );
    expect(rows).toEqual([{ extname: "pgcrypto", nspname: "crypto" }]);
  });
});

/** A past run day: completion is database time, never before the scheduled run (round 19). */
const insertRun = (client: Client, runDate = "2025-04-01") =>
  client.query(
    "insert into job_run (job_name, run_date, scheduled_at) values ('lifecycle.sweep', $1, $2)",
    [runDate, `${runDate}T02:15:00Z`],
  );

// ADR-0011, round 19: one row per job and run day, written once and never changed.
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

// data-protection.md, retention (PR 2g): saved import mappings hold no personal data and no audit
// is needed: the app reads, adds and replaces them, but never deletes or truncates them.
const hmac = (digit: string) => digit.repeat(64);
const insert = (header: string, target = "lastName") =>
  `insert into import_column_mapping (project_id, header_hmac, target, updated_by)
   values ('${seedProjectIds.werkNord}', '${header}', '${target}', '${staffUserId}')`;

describe("transfer_app and the saved import mappings", () => {
  it("may insert, update and select them", async () => {
    await app.query(insert(hmac("a")));
    await app.query(
      "update import_column_mapping set target = 'firstName' where header_hmac = $1",
      [hmac("a")],
    );
    expect((await app.query("select header_hmac, target from import_column_mapping")).rows).toEqual(
      [{ header_hmac: hmac("a"), target: "firstName" }],
    );
  });

  it("keeps one target per header and project", async () => {
    await app.query(insert(hmac("a")));
    await expect(app.query(insert(hmac("a"), "firstName"))).rejects.toMatchObject({
      code: "23505",
    });
  });

  it.each([
    ["header text", insert("Nachname")],
    ["upper-case hex", insert(hmac("A"))],
    ["a short digest", insert("a".repeat(63))],
  ])("stores no %s (23514)", async (_label, sql) => {
    await expect(app.query(sql)).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a target that is not an import target (22P02)", async () => {
    await expect(app.query(insert(hmac("b"), "iban"))).rejects.toMatchObject({ code: "22P02" });
  });

  it.each([
    ["delete from import_column_mapping", "delete from import_column_mapping"],
    ["truncate import_column_mapping", "truncate import_column_mapping"],
  ])("may not %s (42501)", async (_label, sql) => {
    await owner.query(insert(hmac("c")));
    await expect(app.query(sql)).rejects.toMatchObject(permissionDenied);
  });
});

// Slice 4a: assisted mode (ADR-0007, Q136) is read by the app and written only by its functions
// and the staff session's end.
describe("transfer_app and assisted_mode", () => {
  it("may select it", async () => {
    expect((await app.query("select * from assisted_mode")).rows).toEqual([]);
  });

  it.each([
    ...writes(
      "assisted_mode",
      "how",
      `insert into assisted_mode (id, project_id, participation_id, staff_user_id, staff_session_hash, how)
       values (gen_random_uuid(), '${seedProjectIds.werkNord}', gen_random_uuid(),
         '${seedStaffUserIds.projectLead}', '${"a".repeat(64)}', 'phone')`,
    ),
    ["end a mode itself", "update assisted_mode set ended_at = now(), end_reason = 'ended'"],
    ["find a live mode directly", "select lock_assisted_mode(null, null, null)"],
    ["close a mode directly", "select close_assisted_mode(null, null, null)"],
  ])("may not %s (42501)", async (_label, statement) => {
    await expect(app.query(statement)).rejects.toMatchObject(permissionDenied);
  });
});

// Slice 4b: documents (ADR-0002, documents; Q147) are written only by their functions; the runtime
// role never selects the wrapped key or the content hash and has no privilege on the links.
describe("transfer_app and the document tables", () => {
  it("selects the policy and the document metadata", async () => {
    expect((await app.query("select count(*)::int as n from document_type_policy")).rows).toEqual([
      { n: 9 },
    ]);
    expect((await app.query("select id, type, file_name, key_id from document")).rows).toEqual([]);
  });

  it.each([
    ...writes(
      "document",
      "size_bytes",
      `insert into document (id, project_id, participation_id, type, catalog_version, retention_class, media_type, size_bytes, content_sha256, key_id, wrapped_key, added_by, added_on_behalf)
       values (gen_random_uuid(), '${seedProjectIds.werkNord}', gen_random_uuid(), 'cv', 2, 'personnel_file', 'application/pdf', 1, '${"0".repeat(64)}', '${"0".repeat(16)}', '\\x00', 'participant', false)`,
    ),
    ...writes(
      "document_type_policy",
      "file_name",
      "insert into document_type_policy select type, 3, retention_class, file_name, signed, add_roles, review_roles, delete_roles, open_roles from document_type_policy",
    ),
    ...writes(
      "document_link",
      "expires_at",
      `insert into document_link (token_hash, document_id, project_id, participation_id, session_kind, session_hash, expires_at)
       values ('${"a".repeat(64)}', gen_random_uuid(), '${seedProjectIds.werkNord}', gen_random_uuid(), 'staff', '${"b".repeat(64)}', now() + interval '1 minute')`,
    ),
    ["select a wrapped key", "select wrapped_key from document"],
    ["select a content hash", "select content_sha256 from document"],
    ["select everything of a document", "select * from document"],
    ["select a link", "select token_hash from document_link"],
    ["find the actor directly", "select lock_document_actor(null, null, null, false)"],
    ["read roles directly", "select document_staff_roles(null, null)"],
    // Reminders (data-protection.md, reminders): selected, never written but by the functions.
    ...writes(
      "participant_reminder",
      "status",
      `insert into participant_reminder (id, project_id, participation_id, batch_id, kind, message_version, language, channel_id, channel_kind, consent_id, requested_by, requested_on)
       values (gen_random_uuid(), '${seedProjectIds.werkNord}', gen_random_uuid(), gen_random_uuid(), 'open_items', 'portal-reminder:v1', 'de', gen_random_uuid(), 'email', gen_random_uuid(), gen_random_uuid(), current_date)`,
    ),
    ["settle a reminder directly", "select settle_reminder(null, null, null, null)"],
    // Appointments (data-protection.md, appointments): selected, written only by the functions.
    ...writes(
      "appointment",
      "capacity",
      `insert into appointment (id, project_id, kind, starts_at, ends_at, booking_closes_at, capacity, venue, created_by)
       values (gen_random_uuid(), '${seedProjectIds.werkNord}', 'info_event', now() + interval '2 days', now() + interval '3 days', now() + interval '1 day', 10, 'Raum 1', gen_random_uuid())`,
    ),
    ...writes(
      "appointment_booking",
      "status",
      `insert into appointment_booking (id, project_id, participation_id, appointment_id, origin, booked_by)
       values (gen_random_uuid(), '${seedProjectIds.werkNord}', gen_random_uuid(), gen_random_uuid(), 'staff', gen_random_uuid())`,
    ),
    ["read roles of a project directly", "select appointment_member_roles(null, null)"],
    ["cancel a booking row directly", "select cancel_booking_row(null, null, null, null)"],
    ["lock participations directly", "select lock_appointment_participations(null)"],
    ["call the terminal-booking trigger", "select cancel_bookings_at_terminal_status()"],
    ["confirm informed directly", "select confirm_informed(null, null, null, null)"],
    ["lock a conflict's booking directly", "select lock_conflict_booking(null, null)"],
    // Messages (data-protection.md, messages): the new columns are written by the functions only.
    [
      "update a message's follow-up",
      "update participant_reminder set followed_up_method = 'phone', followed_up_by = gen_random_uuid(), followed_up_at = now()",
    ],
    ["update a message's appointment", "update participant_reminder set appointment_id = null"],
    ["read a notice's context directly", "select appointment_notice_context(null)"],
    ["read a job's context directly", "select message_job_context(null, null)"],
    ["check a booking directly", "select appointment_booking_refusal(null, null, null)"],
    [
      "queue an appointment's message directly",
      "select queue_appointment_message(null, null, null, null, null, null)",
    ],
    [
      "queue an organizer's notice directly",
      "select queue_appointment_notice(null, null, null, null, null)",
    ],
  ])("may not %s (42501)", async (_label, statement) => {
    await expect(app.query(statement)).rejects.toMatchObject(permissionDenied);
  });
});

// Slice 5: the audit history (ADR-0002, the audit history; Q157): the reference tables are
// selected, written only by the migrations; the trail itself stays closed to the runtime role.
describe("transfer_app and the audit history", () => {
  it("selects the reference tables", async () => {
    const counts = await app.query(
      `select (select count(*)::int from audit_event_projection) as projection,
         (select count(*)::int from role_field_knowledge) as knowledge,
         (select count(*)::int from field_access_category) as fields`,
    );
    expect(counts.rows[0].projection).toBeGreaterThan(0);
    expect(counts.rows[0].knowledge).toBeGreaterThan(0);
    expect(counts.rows[0].fields).toBeGreaterThan(0);
  });

  it.each([
    ...writes(
      "audit_event_projection",
      "shows_reason",
      "insert into audit_event_projection values ('x_event', null, 'case', true, true, '{reasonCode}')",
    ),
    ...writes(
      "role_field_knowledge",
      "access_category",
      "insert into role_field_knowledge values ('back_office', 'health')",
    ),
    ...writes(
      "field_access_category",
      "access_category",
      "insert into field_access_category values ('xField', 'case_internal')",
    ),
    ["select the trail", "select * from audit_event"],
    ["filter details directly", "select audit_history_details('{}', '{}', '{}')"],
  ])("may not %s (42501)", async (_label, statement) => {
    await expect(app.query(statement)).rejects.toMatchObject(permissionDenied);
  });
});
