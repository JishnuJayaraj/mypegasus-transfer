import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedRegionIds, seedStaffUserIds } from "./seed";
import { auditContext, call, pl, resetTestDatabase, testDatabaseUrls } from "./testing";

// The org model (Q62, Q126; data-protection.md, access matrix): regions, staff accounts and org
// roles by the global admin, teams by the PL, assignments to project consultants. Written only by
// their SECURITY DEFINER functions, each with its audit events in the same transaction.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const other = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });

const { admin, regionalAdmin, projectLead, consultant, backOffice, regionalOperationsManager } =
  seedStaffUserIds;
const { werkNord, lagerSued, verwaltung } = seedProjectIds;
const requestId = "0c4b1f4e-1111-4000-8000-000000000001";
const asUser = (staffUserId: string, onBehalfOf?: string) =>
  auditContext({ actorType: "user", staffUserId, onBehalfOf: onBehalfOf ?? null, requestId });
const asAdmin = asUser(admin);

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { code: string; message: string }) =>
      error.code === "P0001" ? error.message : error.code,
  );

const staffEvents = async () =>
  (
    await owner.query(
      `select event_type, actor_staff_user_id, subject_staff_user_id, details, request_id
       from staff_audit_event order by seq`,
    )
  ).rows;

const projectEvents = async (types: string[]) =>
  (
    await owner.query(
      `select event_type, project_id, participation_id, actor_staff_user_id, reason_code, details
       from audit_event where event_type::text = any($1) order by seq`,
      [types],
    )
  ).rows;

const count = async (table: string) =>
  (await owner.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;

const members = async (projectId: string) =>
  (
    await owner.query(
      "select staff_user_id, role from project_membership where project_id = $1 order by staff_user_id, role",
      [projectId],
    )
  ).rows;

const participation = (projectId = werkNord) =>
  call(app, "create_participation", { projectId, context: pl });

const assign = (participationIds: string[], args: Record<string, unknown> = {}) =>
  call<number>(app, "assign_participations", {
    projectId: werkNord,
    staffUserId: consultant,
    participationIds,
    context: pl,
    ...args,
  });

const openAssignments = async () =>
  (
    await owner.query(
      "select participation_id, staff_user_id from participant_assignment where ended_at is null order by participation_id",
    )
  ).rows;

const startSession = (staffUserId: string) =>
  call(app, "start_staff_session", {
    staffUserId,
    tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
    method: "dev",
    oidcIssuer: null,
    oidcSubject: null,
    supersededTokenHash: null,
    requestId,
  });

/** Runs `sql` in a transaction of `client` that gives up waiting for a lock after 300 ms. */
async function tryWithin(client: Client, sql: string, params: unknown[] = []) {
  await client.query("begin");
  await client.query("set local lock_timeout = '300ms'");
  try {
    return await refusal(client.query(sql, params));
  } finally {
    await client.query("rollback");
  }
}

/** Holds the exclusive project lock of `projectId` in `app` while `run` runs. */
async function whileLocked(projectId: string, run: () => Promise<void>) {
  await app.query("begin");
  try {
    await app.query("select lock_project_setup($1)", [projectId]);
    await run();
  } finally {
    await app.query("rollback");
  }
}

beforeAll(() => Promise.all([app.connect(), other.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), other.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, keepSessions: false }));

describe("regions (Q35, Q126)", () => {
  const create = (args: Record<string, unknown> = {}) =>
    call(app, "create_region", {
      code: "OST",
      name: "Niederlassung Ost",
      actor: admin,
      requestId,
      ...args,
    });

  it("are created by the global admin, audited by id, never by name", async () => {
    const id = await create();
    expect((await app.query("select code, name from region where id = $1", [id])).rows).toEqual([
      { code: "OST", name: "Niederlassung Ost" },
    ]);
    expect(await staffEvents()).toEqual([
      {
        event_type: "region_created",
        actor_staff_user_id: admin,
        subject_staff_user_id: null,
        details: { regionId: id },
        request_id: requestId,
      },
    ]);
  });

  it.each([
    ["a PL", { actor: projectLead }, "actor_not_allowed"],
    ["a regional admin", { actor: regionalAdmin }, "actor_not_allowed"],
    ["no actor", { actor: null }, "actor_not_allowed"],
    ["a lower-case code", { code: "ost" }, "invalid_argument"],
    ["an untrimmed name", { name: " Ost" }, "invalid_argument"],
    ["a taken code", { code: "NORD" }, "region_code_taken"],
  ])("refuse %s without a write", async (_label, args, code) => {
    expect(await refusal(create(args))).toBe(code);
    expect(await count("region")).toBe(2);
    expect(await staffEvents()).toEqual([]);
  });

  it("refuse a deactivated admin", async () => {
    await owner.query("update staff_user set deactivated_at = now() where id = $1", [admin]);
    expect(await refusal(create())).toBe("actor_not_allowed");
  });

  it("change code or name with the changed keys; refuse no change and a taken code", async () => {
    const update = (args: Record<string, unknown>) =>
      call(app, "update_region", { id: seedRegionIds.nord, actor: admin, requestId, ...args });
    await update({ name: "Nord-Ost", code: null });
    expect((await staffEvents()).at(-1)).toMatchObject({
      event_type: "region_changed",
      details: { regionId: seedRegionIds.nord, fields: ["name"] },
    });
    expect(await refusal(update({ name: "Nord-Ost" }))).toBe("region_unchanged");
    expect(await refusal(update({ code: "SUED" }))).toBe("region_code_taken");
    expect(await refusal(update({ id: werkNord, name: "X" }))).toBe("region_not_found");
    expect(await refusal(update({ actor: projectLead, name: "X" }))).toBe("actor_not_allowed");
    expect(await staffEvents()).toHaveLength(1);
  });
});

describe("staff accounts (Q7, Q126)", () => {
  const create = (args: Record<string, unknown> = {}) =>
    call(app, "create_staff_user", {
      displayName: "Anna Beispiel",
      email: "anna.beispiel@example.org",
      mayCreateProjects: true,
      actor: admin,
      requestId,
      ...args,
    });

  it("are created by the global admin; the event names the flag, never name or email", async () => {
    const id = await create();
    const { rows } = await app.query(
      "select display_name, email, may_create_projects, deactivated_at from staff_user where id = $1",
      [id],
    );
    expect(rows).toEqual([
      {
        display_name: "Anna Beispiel",
        email: "anna.beispiel@example.org",
        may_create_projects: true,
        deactivated_at: null,
      },
    ]);
    expect(await staffEvents()).toEqual([
      {
        event_type: "staff_account_created",
        actor_staff_user_id: admin,
        subject_staff_user_id: id,
        details: { mayCreateProjects: true },
        request_id: requestId,
      },
    ]);
  });

  it.each([
    ["a PL", { actor: projectLead }, "actor_not_allowed"],
    ["a regional admin", { actor: regionalAdmin }, "actor_not_allowed"],
    ["an address taken in another case", { email: "Project-Lead@Example.org" }, "email_taken"],
    ["an address without @", { email: "anna.example.org" }, "invalid_argument"],
    ["an empty name", { displayName: "" }, "invalid_argument"],
    ["no flag", { mayCreateProjects: null }, "invalid_argument"],
  ])("refuse %s without a write", async (_label, args, code) => {
    expect(await refusal(create(args))).toBe(code);
    expect(await count("staff_user")).toBe(6);
    expect(await staffEvents()).toEqual([]);
  });

  it("change name, email or the flag with the changed keys and the flag's value", async () => {
    const update = (args: Record<string, unknown>) =>
      call(app, "update_staff_user", { id: consultant, actor: admin, requestId, ...args });
    await update({ displayName: "Bernd Berater", mayCreateProjects: true });
    expect((await staffEvents()).at(-1)).toEqual({
      event_type: "staff_account_changed",
      actor_staff_user_id: admin,
      subject_staff_user_id: consultant,
      details: { fields: ["displayName", "mayCreateProjects"], mayCreateProjects: true },
      request_id: requestId,
    });
    await update({ email: "bernd@example.org" });
    expect((await staffEvents()).at(-1)!.details).toEqual({ fields: ["email"] });
    expect(await refusal(update({ displayName: "Bernd Berater" }))).toBe("staff_user_unchanged");
    expect(await refusal(update({ email: "admin@example.org" }))).toBe("email_taken");
    expect(await refusal(update({ id: werkNord, displayName: "X" }))).toBe("unknown_account");
    expect(await refusal(update({ actor: consultant, displayName: "X" }))).toBe(
      "actor_not_allowed",
    );
    await owner.query("update staff_user set deactivated_at = now() where id = $1", [consultant]);
    expect(await refusal(update({ displayName: "X" }))).toBe("account_deactivated");
    expect(await staffEvents()).toHaveLength(2);
  });
});

describe("org roles (Q80, Q126)", () => {
  const grant = (args: Record<string, unknown> = {}) =>
    call(app, "grant_org_role", {
      staffUserId: consultant,
      role: "regional_admin",
      regionId: seedRegionIds.sued,
      actor: admin,
      requestId,
      ...args,
    });
  const revoke = (args: Record<string, unknown> = {}) =>
    call(app, "revoke_org_role", {
      staffUserId: regionalAdmin,
      role: "regional_admin",
      regionId: seedRegionIds.nord,
      actor: admin,
      requestId,
      ...args,
    });
  const rolesOf = async (staffUserId: string) =>
    (
      await owner.query(
        "select role, region_id, granted_by from staff_org_role where staff_user_id = $1",
        [staffUserId],
      )
    ).rows;

  it("are granted per region, admin globally, with the role and region in the event", async () => {
    await grant();
    await grant({ role: "admin", regionId: null });
    expect(await rolesOf(consultant)).toEqual([
      { role: "regional_admin", region_id: seedRegionIds.sued, granted_by: admin },
      { role: "admin", region_id: null, granted_by: admin },
    ]);
    expect(
      (await staffEvents()).map(({ event_type, subject_staff_user_id, details }) => [
        event_type,
        subject_staff_user_id,
        details,
      ]),
    ).toEqual([
      ["org_role_granted", consultant, { role: "regional_admin", regionId: seedRegionIds.sued }],
      ["org_role_granted", consultant, { role: "admin", regionId: null }],
    ]);
  });

  it.each([
    [
      "a role held already",
      { staffUserId: regionalAdmin, regionId: seedRegionIds.nord },
      "org_role_exists",
    ],
    ["admin for a region", { role: "admin" }, "invalid_argument"],
    ["a regional role without a region", { regionId: null }, "invalid_argument"],
    ["an unknown region", { regionId: werkNord }, "region_not_found"],
    ["an unknown account", { staffUserId: werkNord }, "unknown_account"],
    ["a regional admin granting", { actor: regionalAdmin }, "actor_not_allowed"],
  ])("refuse %s", async (_label, args, code) => {
    expect(await refusal(grant(args))).toBe(code);
    expect(await staffEvents()).toEqual([]);
  });

  it("are granted only to active accounts", async () => {
    await owner.query("update staff_user set deactivated_at = now() where id = $1", [consultant]);
    expect(await refusal(grant())).toBe("account_deactivated");
  });

  it("are revoked (the row goes, the event stays); never one's own admin role", async () => {
    await revoke();
    expect(await rolesOf(regionalAdmin)).toEqual([]);
    expect(await staffEvents()).toEqual([
      expect.objectContaining({
        event_type: "org_role_revoked",
        subject_staff_user_id: regionalAdmin,
        details: { role: "regional_admin", regionId: seedRegionIds.nord },
      }),
    ]);
    expect(await refusal(revoke())).toBe("org_role_not_found");
    expect(await refusal(revoke({ staffUserId: admin, role: "admin", regionId: null }))).toBe(
      "own_account",
    );
    expect(await refusal(revoke({ actor: projectLead }))).toBe("actor_not_allowed");
  });
});

describe("project members (Q61, Q126)", () => {
  const add = (args: Record<string, unknown> = {}) =>
    call(app, "add_project_member", {
      projectId: werkNord,
      staffUserId: backOffice,
      role: "consultant",
      context: asUser(projectLead),
      ...args,
    });
  const remove = (args: Record<string, unknown> = {}) =>
    call(app, "remove_project_member", {
      projectId: werkNord,
      staffUserId: backOffice,
      role: "back_office",
      context: asUser(projectLead),
      ...args,
    });

  it("are added by the PL, in any role, with project_member_added", async () => {
    await add();
    expect(await members(werkNord)).toContainEqual({
      staff_user_id: backOffice,
      role: "consultant",
    });
    expect(await projectEvents(["project_member_added"])).toEqual([
      {
        event_type: "project_member_added",
        project_id: werkNord,
        participation_id: null,
        actor_staff_user_id: projectLead,
        reason_code: null,
        details: { staffUserId: backOffice, role: "consultant" },
      },
    ]);
  });

  it("let a global admin add a replacement PL, never themselves, nothing else", async () => {
    await add({ role: "project_lead", context: asAdmin });
    expect(await members(werkNord)).toContainEqual({
      staff_user_id: backOffice,
      role: "project_lead",
    });
    expect(await refusal(add({ staffUserId: admin, role: "project_lead", context: asAdmin }))).toBe(
      "own_account",
    );
    expect(await refusal(add({ context: asAdmin }))).toBe("actor_not_allowed");
  });

  it.each([
    [
      "a regional admin",
      { role: "project_lead", context: asUser(regionalAdmin) },
      "actor_not_allowed",
    ],
    ["a consultant", { context: asUser(consultant) }, "actor_not_allowed"],
    [
      "the PL of another project",
      { projectId: lagerSued, context: asUser(consultant) },
      "actor_not_allowed",
    ],
    ["assisted mode", { context: asUser(projectLead, werkNord) }, "invalid_actor"],
    ["a role held already", { role: "back_office" }, "membership_exists"],
    ["an unknown account", { staffUserId: werkNord }, "unknown_account"],
    ["an unknown project", { projectId: seedRegionIds.nord }, "project_not_found"],
  ])("refuse %s without a write", async (_label, args, code) => {
    expect(await refusal(add(args))).toBe(code);
    expect(await projectEvents(["project_member_added"])).toEqual([]);
  });

  it("refuse a deactivated account", async () => {
    await owner.query("update staff_user set deactivated_at = now() where id = $1", [backOffice]);
    expect(await refusal(add())).toBe("account_deactivated");
  });

  it("are removed by the PL with project_member_removed", async () => {
    await remove();
    expect(await members(werkNord)).not.toContainEqual({
      staff_user_id: backOffice,
      role: "back_office",
    });
    expect(await projectEvents(["project_member_removed"])).toEqual([
      expect.objectContaining({
        actor_staff_user_id: projectLead,
        reason_code: "member_removed",
        details: { staffUserId: backOffice, role: "back_office" },
      }),
    ]);
    expect(await refusal(remove())).toBe("membership_not_found");
    expect(await refusal(remove({ role: "consultant", context: asAdmin }))).toBe(
      "actor_not_allowed",
    );
  });

  it("keep the last active PL; with another PL the PL may step down", async () => {
    const stepDown = { staffUserId: projectLead, role: "project_lead" };
    expect(await refusal(remove(stepDown))).toBe("last_project_lead");
    expect(await members(werkNord)).toContainEqual({
      staff_user_id: projectLead,
      role: "project_lead",
    });
    await add({ role: "project_lead", context: asAdmin });
    await remove(stepDown);
    expect((await members(werkNord)).filter((m) => m.role === "project_lead")).toEqual([
      { staff_user_id: backOffice, role: "project_lead" },
    ]);
  });

  it("end the consultant's assignments in the project when the consultant role goes", async () => {
    const [a, b] = [await participation(), await participation()];
    await assign([a, b]);
    const other = await participation(verwaltung);
    await assign([other], { projectId: verwaltung });
    await remove({ staffUserId: consultant, role: "consultant" });
    expect(await openAssignments()).toEqual([
      { participation_id: other, staff_user_id: consultant },
    ]);
    expect(
      (await projectEvents(["participant_unassigned"])).map((e) => [
        e.participation_id,
        e.reason_code,
        e.details.staffUserId,
      ]),
    ).toEqual([a, b].toSorted().map((id) => [id, "consultant_removed", consultant]));
    const { rows } = await owner.query(
      "select count(*)::int as n from participant_assignment where end_reason = 'consultant_removed' and ended_by = $1",
      [projectLead],
    );
    expect(rows).toEqual([{ n: 2 }]);
  });
});

describe("participant assignments (Q62)", () => {
  it("assign participations to a project consultant, each with participant_assigned", async () => {
    const [a, b] = [await participation(), await participation()];
    expect(await assign([a, b])).toBe(2);
    expect(await openAssignments()).toEqual(
      [a, b].toSorted().map((id) => ({ participation_id: id, staff_user_id: consultant })),
    );
    const events = await projectEvents(["participant_assigned"]);
    expect(events.map((e) => [e.participation_id, e.details.staffUserId])).toEqual(
      [a, b].toSorted().map((id) => [id, consultant]),
    );
    // Already assigned ones count nothing; a new one is added
    const c = await participation();
    expect(await assign([a, c])).toBe(1);
    expect(await openAssignments()).toHaveLength(3);
  });

  it.each([
    ["to a member without consultant", { staffUserId: backOffice }, "not_consultant"],
    ["to a non-member", { staffUserId: admin }, "not_consultant"],
    ["by a consultant", { context: asUser(consultant) }, "actor_not_allowed"],
    ["by a global admin", { context: asAdmin }, "actor_not_allowed"],
    ["in assisted mode", { context: asUser(projectLead, werkNord) }, "invalid_actor"],
  ])("refuse an assignment %s", async (_label, args, code) => {
    const a = await participation();
    expect(await refusal(assign([a], args))).toBe(code);
    expect(await count("participant_assignment")).toBe(0);
  });

  it("refuse a participation of another project, duplicates and more than 500, all or nothing", async () => {
    const a = await participation();
    const elsewhere = await participation(verwaltung);
    expect(await refusal(assign([a, elsewhere]))).toBe("participation_not_found");
    expect(await refusal(assign([a, a]))).toBe("invalid_argument");
    expect(await refusal(assign([]))).toBe("invalid_argument");
    const many = Array.from({ length: 501 }, () => crypto.randomUUID());
    expect(await refusal(assign(many))).toBe("invalid_argument");
    expect(await count("participant_assignment")).toBe(0);
    expect(await projectEvents(["participant_assigned"])).toEqual([]);
  });

  it("close an assignment, keep the row, and refuse closing it twice", async () => {
    const a = await participation();
    await assign([a]);
    const unassign = (args: Record<string, unknown> = {}) =>
      call(app, "unassign_participation", {
        participationId: a,
        staffUserId: consultant,
        context: pl,
        ...args,
      });
    expect(await refusal(unassign({ context: asUser(consultant) }))).toBe("actor_not_allowed");
    await unassign();
    expect(await openAssignments()).toEqual([]);
    const { rows } = await owner.query(
      "select end_reason, ended_by, ended_at >= assigned_at as ordered from participant_assignment",
    );
    expect(rows).toEqual([{ end_reason: "unassigned", ended_by: projectLead, ordered: true }]);
    expect(await projectEvents(["participant_unassigned"])).toEqual([
      expect.objectContaining({ participation_id: a, reason_code: "unassigned" }),
    ]);
    expect(await refusal(unassign())).toBe("assignment_not_found");
    expect(await refusal(unassign({ participationId: werkNord }))).toBe("participation_not_found");
    // Assigned again later: a new row, the closed one stays
    await assign([a]);
    expect(await count("participant_assignment")).toBe(2);
  });
});

describe("deactivate_staff_user (Q59, Q126)", () => {
  const deactivate = (id: string, actor = admin) =>
    call(app, "deactivate_staff_user", { id, actor, requestId });

  it("ends sessions, memberships and assignments in one transaction, with the counts", async () => {
    const a = await participation();
    await assign([a]);
    await startSession(consultant);
    await startSession(projectLead);
    await deactivate(consultant);
    const { rows: sessions } = await owner.query(
      "select staff_user_id, end_reason from staff_session order by staff_user_id",
    );
    expect(sessions).toEqual([
      { staff_user_id: projectLead, end_reason: null },
      { staff_user_id: consultant, end_reason: "deactivated" },
    ]);
    for (const projectId of [werkNord, lagerSued, verwaltung]) {
      expect((await members(projectId)).map((m) => m.staff_user_id)).not.toContain(consultant);
    }
    expect(await openAssignments()).toEqual([]);
    expect(
      (await projectEvents(["participant_unassigned", "project_member_removed"])).map((e) => [
        e.event_type,
        e.reason_code,
        e.actor_staff_user_id,
      ]),
    ).toEqual([
      ["participant_unassigned", "account_deactivated", admin],
      ...Array(3).fill(["project_member_removed", "account_deactivated", admin]),
    ]);
    expect((await staffEvents()).at(-1)).toEqual({
      event_type: "staff_account_deactivated",
      actor_staff_user_id: admin,
      subject_staff_user_id: consultant,
      details: { endedSessions: 1, removedMemberships: 3, endedAssignments: 1 },
      request_id: requestId,
    });
    const { rows } = await owner.query(
      "select deactivated_at is not null as deactivated from staff_user where id = $1",
      [consultant],
    );
    expect(rows).toEqual([{ deactivated: true }]);
    // No login and no new team role afterwards
    expect(await refusal(startSession(consultant))).toBe("account_deactivated");
    expect(await refusal(deactivate(consultant))).toBe("account_deactivated");
  });

  it("is refused for the last active PL of a project, and leaves everything as it was", async () => {
    await startSession(projectLead);
    expect(await refusal(deactivate(projectLead))).toBe("last_project_lead");
    expect(await count("staff_session where ended_at is null")).toBe(1);
    expect(await members(werkNord)).toContainEqual({
      staff_user_id: projectLead,
      role: "project_lead",
    });
    expect(await staffEvents()).toHaveLength(1); // the login
  });

  it("succeeds once every project has another active PL", async () => {
    for (const projectId of [werkNord, lagerSued, verwaltung]) {
      await call(app, "add_project_member", {
        projectId,
        staffUserId: backOffice,
        role: "project_lead",
        context: asAdmin,
      });
    }
    await deactivate(projectLead);
    // A deactivated PL never counts: now back office is the last PL
    expect(await refusal(deactivate(backOffice))).toBe("last_project_lead");
  });

  it("is the global admin's, never of their own account", async () => {
    expect(await refusal(deactivate(admin))).toBe("own_account");
    expect(await refusal(deactivate(consultant, regionalAdmin))).toBe("actor_not_allowed");
    expect(await refusal(deactivate(consultant, regionalOperationsManager))).toBe(
      "actor_not_allowed",
    );
    expect(await refusal(deactivate(werkNord))).toBe("unknown_account");
  });
});

describe("the project lock (ADR-0002, read, decide, write under the project lock)", () => {
  it("serialises team, assignment and deactivation changes with the project's other mutations", async () => {
    const a = await participation();
    await whileLocked(werkNord, async () => {
      expect(
        await tryWithin(
          other,
          "select add_project_member($1, $2, 'consultant', $3::audit_context)",
          [werkNord, backOffice, pl],
        ),
      ).toBe("55P03");
      expect(
        await tryWithin(
          other,
          "select assign_participations($1, $2, array[$3]::uuid[], $4::audit_context)",
          [werkNord, consultant, a, pl],
        ),
      ).toBe("55P03");
      expect(
        await tryWithin(other, "select deactivate_staff_user($1, $2, $3)", [
          consultant,
          admin,
          requestId,
        ]),
      ).toBe("55P03");
    });
  });
});

describe("the staff audit event shape", () => {
  const insert = async (values: Record<string, unknown>) => {
    const columns = Object.keys(values);
    await owner.query("begin");
    try {
      await owner.query(
        `insert into staff_audit_event (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
        columns.map((c) => (c === "details" ? JSON.stringify(values[c]) : values[c])),
      );
      return "ok";
    } catch (error) {
      return (error as { constraint?: string }).constraint;
    } finally {
      await owner.query("rollback");
    }
  };

  it("holds an account event to an actor and a subject, a region event to its region", async () => {
    const shape = "staff_audit_event_shape";
    const ofAccount = { actor_staff_user_id: admin, subject_staff_user_id: consultant };
    expect(await insert({ event_type: "staff_account_created", ...ofAccount })).toBe("ok");
    expect(await insert({ event_type: "staff_account_created", actor_staff_user_id: admin })).toBe(
      shape,
    );
    expect(
      await insert({ event_type: "org_role_granted", subject_staff_user_id: consultant }),
    ).toBe(shape);
    const region = { regionId: seedRegionIds.nord };
    expect(
      await insert({ event_type: "region_created", actor_staff_user_id: admin, details: region }),
    ).toBe("ok");
    expect(await insert({ event_type: "region_created", actor_staff_user_id: admin })).toBe(shape);
    expect(await insert({ event_type: "region_changed", ...ofAccount, details: region })).toBe(
      shape,
    );
    // The login events stay the actor's own; a refusal stays actor-less
    expect(await insert({ event_type: "staff_login", ...ofAccount })).toBe(shape);
    expect(
      await insert({
        event_type: "staff_login_refused",
        actor_staff_user_id: admin,
        reason_code: "unknown_account",
      }),
    ).toBe(shape);
  });
});
