import { createDb, seedProjectIds, seedRegionIds, seedStaffUserIds } from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  AssignmentResult,
  CurrentStaffUser,
  DevStaffUser,
  page,
  ParticipationDetail,
  ParticipationPage,
  Project,
  ProjectTeam,
  Region,
  StaffAccount,
  StaffAccountPage,
  StaffDirectoryEntry,
} from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// Regions, org roles, staff accounts, teams and assignments (Q62, Q126; data-protection.md,
// access matrix): region scope for the org roles, the global admin's administration, the PL's
// team, and consultants who see exactly their assigned participations.
const { app, db } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord, lagerSued, verwaltung } = seedProjectIds;
const { admin, regionalAdmin, projectLead, consultant, backOffice, regionalOperationsManager } =
  seedStaffUserIds;

type Auth = { Cookie: string };
const sessions: Record<string, Auth> = {};
const as = (staffUserId: string) => sessions[staffUserId]!;

const get = (path: string, auth: Auth) => app.request(`/api/v1${path}`, { headers: auth });
const send = (method: string, path: string, auth: Auth, body: unknown = {}) =>
  app.request(`/api/v1${path}`, jsonRequest(method, body, auth));
const del = (path: string, auth: Auth) =>
  app.request(`/api/v1${path}`, {
    method: "DELETE",
    headers: { ...auth, Origin: "http://localhost:5173" },
  });

const ProjectPage = page(Project);
const projectIds = async (auth: Auth) =>
  (await readJson(await get("/projects", auth), ProjectPage)).items.map((p) => p.id).toSorted();

/** Creates participations of Werk Nord directly as the owner (a fixture). */
async function participations(count: number, projectId: string = werkNord) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const { rows } = await owner.$client.query(
      `select create_participation(p_project_id => $1, p_context => row('user', $2, null, null, null, null, null)::audit_context) as id`,
      [projectId, projectLead],
    );
    ids.push(rows[0].id);
  }
  return ids;
}

const assign = (
  participationIds: string[],
  staffUserId: string = consultant,
  auth = as(projectLead),
) => send("POST", `/projects/${werkNord}/assignments`, auth, { staffUserId, participationIds });

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of Object.values(seedStaffUserIds)) sessions[id] = await login(app, id);
});
beforeEach(() => resetTestDatabase({ seed: true, active: true }));
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

describe("the session user (Q126)", () => {
  it("carries the project-creation flag and the org roles, no flat role", async () => {
    const me = await readJson(await get("/me", as(regionalAdmin)), CurrentStaffUser);
    expect(me).toMatchObject({
      mayCreateProjects: false,
      orgRoles: [{ role: "regional_admin", regionId: seedRegionIds.nord }],
    });
    expect(me).not.toHaveProperty("role");
    const pl = await readJson(await get("/me", as(projectLead)), CurrentStaffUser);
    expect(pl).toMatchObject({ mayCreateProjects: true, orgRoles: [] });
  });

  it("labels the dev switcher's users with the role they are known by", async () => {
    const users = await readJson(
      await app.request("/api/v1/dev/staff-users"),
      z.array(DevStaffUser),
    );
    expect(Object.fromEntries(users.map((u) => [u.id, u.role]))).toEqual({
      [admin]: "admin",
      [regionalAdmin]: "regional_admin",
      [projectLead]: "project_lead",
      [consultant]: "consultant",
      [backOffice]: "back_office",
      [regionalOperationsManager]: "regional_operations_manager",
    });
  });
});

describe("region scope (Q106, Q126)", () => {
  it("shows the regional roles their region's projects, global roles and members theirs", async () => {
    const nord = [werkNord, verwaltung].toSorted();
    expect(await projectIds(as(regionalAdmin))).toEqual(nord);
    expect(await projectIds(as(regionalOperationsManager))).toEqual(nord);
    expect(await projectIds(as(admin))).toEqual([werkNord, lagerSued, verwaltung].toSorted());
    expect(await projectIds(as(projectLead))).toHaveLength(3);
    await expectProblem(await get(`/projects/${lagerSued}`, as(regionalAdmin)), 404, "not-found");
    expect((await get(`/projects/${werkNord}`, as(regionalAdmin))).status).toBe(200);
  });

  it("shows a project without a region only to global roles and members", async () => {
    await owner.$client.query("update project set region_id = null where id = $1", [werkNord]);
    expect(await projectIds(as(regionalAdmin))).toEqual([verwaltung]);
    expect(await projectIds(as(admin))).toContain(werkNord);
    expect(await projectIds(as(projectLead))).toContain(werkNord);
  });

  it("keeps the regional operations manager's decisions to its region", async () => {
    // A relaxation request in Lager Süd is out of its region: the project is a 404 for it.
    await expectProblem(
      await get(`/projects/${lagerSued}/config`, as(regionalOperationsManager)),
      404,
      "not-found",
    );
    expect((await get(`/projects/${werkNord}/config`, as(regionalOperationsManager))).status).toBe(
      200,
    );
  });
});

describe("projects and their region (Q126)", () => {
  const body = { name: "Projekt Ost", customerName: "Beispiel GmbH", type: "ta_only" };

  it("is chosen by the creator, who becomes the PL", async () => {
    const res = await send("POST", "/projects", as(projectLead), {
      ...body,
      regionId: seedRegionIds.sued,
    });
    expect(res.status).toBe(201);
    const created = await readJson(res, Project);
    expect(created.regionId).toBe(seedRegionIds.sued);
    const team = await readJson(
      await get(`/projects/${created.id}/members`, as(projectLead)),
      ProjectTeam,
    );
    expect(team.members).toEqual([
      {
        staffUserId: projectLead,
        displayName: "Petra Projektleitung",
        roles: ["project_lead"],
        deactivated: false,
      },
    ]);
  });

  it("is required, and must exist; only staff who may create projects create them", async () => {
    const missing = await expectProblem(
      await send("POST", "/projects", as(projectLead), body),
      422,
      "domain-error",
    );
    expect(missing.errors?.map((e) => e.code)).toEqual(["region_required"]);
    const unknown = await expectProblem(
      await send("POST", "/projects", as(projectLead), { ...body, regionId: werkNord }),
      422,
      "domain-error",
    );
    expect(unknown.errors?.map((e) => e.code)).toEqual(["region_not_found"]);
    for (const user of [admin, regionalAdmin, consultant]) {
      await expectProblem(
        await send("POST", "/projects", as(user), { ...body, regionId: seedRegionIds.nord }),
        403,
        "forbidden",
      );
    }
  });

  it("is changed by the PL only while draft, by the global admin at any time", async () => {
    const toSued = { regionId: seedRegionIds.sued };
    // Lager Süd is a draft, Werk Nord active
    const draft = await send("PATCH", `/projects/${lagerSued}`, as(projectLead), {
      regionId: seedRegionIds.nord,
    });
    expect((await readJson(draft, Project)).regionId).toBe(seedRegionIds.nord);
    const active = await expectProblem(
      await send("PATCH", `/projects/${werkNord}`, as(projectLead), toSued),
      422,
      "domain-error",
    );
    expect(active.errors?.map((e) => e.code)).toEqual(["project_not_draft"]);
    const byAdmin = await send("PATCH", `/projects/${werkNord}`, as(admin), toSued);
    expect((await readJson(byAdmin, Project)).regionId).toBe(seedRegionIds.sued);
    // The admin changes the region, never the project's other fields
    await expectProblem(
      await send("PATCH", `/projects/${werkNord}`, as(admin), { name: "Umbenannt" }),
      403,
      "forbidden",
    );
    await expectProblem(
      await send("PATCH", `/projects/${verwaltung}`, as(regionalAdmin), toSued),
      403,
      "forbidden",
    );
  });
});

describe("staff administration (Q126)", () => {
  const anna = { displayName: "Anna Beispiel", email: "anna@example.org" };

  it("is the global admin's: accounts, the flag and org roles", async () => {
    const created = await readJson(
      await send("POST", "/staff-users", as(admin), anna),
      StaffAccount,
    );
    expect(created).toMatchObject({
      ...anna,
      mayCreateProjects: false,
      orgRoles: [],
      identityBound: false,
      deactivatedAt: null,
    });
    const changed = await readJson(
      await send("PATCH", `/staff-users/${created.id}`, as(admin), { mayCreateProjects: true }),
      StaffAccount,
    );
    expect(changed.mayCreateProjects).toBe(true);
    const roles = [{ role: "regional_admin", regionId: seedRegionIds.sued }] as const;
    const granted = await readJson(
      await send("PUT", `/staff-users/${created.id}/org-roles`, as(admin), { orgRoles: roles }),
      StaffAccount,
    );
    expect(granted.orgRoles).toEqual(roles);
    const revoked = await readJson(
      await send("PUT", `/staff-users/${created.id}/org-roles`, as(admin), { orgRoles: [] }),
      StaffAccount,
    );
    expect(revoked.orgRoles).toEqual([]);
    const list = await readJson(await get("/staff-users?limit=100", as(admin)), StaffAccountPage);
    expect(list.items.map((a) => a.id)).toContain(created.id);
    const { rows } = await owner.$client.query(
      "select event_type::text from staff_audit_event where subject_staff_user_id = $1 order by seq",
      [created.id],
    );
    expect(rows.map((r) => r.event_type)).toEqual([
      "staff_account_created",
      "staff_account_changed",
      "org_role_granted",
      "org_role_revoked",
    ]);
  });

  it("refuses everyone else, the regional admin too", async () => {
    for (const user of [regionalAdmin, projectLead, regionalOperationsManager]) {
      await expectProblem(await send("POST", "/staff-users", as(user), anna), 403, "forbidden");
      await expectProblem(await get("/staff-users", as(user)), 403, "forbidden");
      await expectProblem(
        await send("PATCH", `/staff-users/${consultant}`, as(user), { mayCreateProjects: true }),
        403,
        "forbidden",
      );
      await expectProblem(
        await send("POST", `/staff-users/${consultant}/deactivation`, as(user)),
        403,
        "forbidden",
      );
      await expectProblem(
        await send("PUT", `/staff-users/${user}/org-roles`, as(user), {
          orgRoles: [{ role: "admin", regionId: null }],
        }),
        403,
        "forbidden",
      );
      await expectProblem(
        await send("POST", "/regions", as(user), { code: "OST", name: "Ost" }),
        403,
        "forbidden",
      );
    }
  });

  it("answers taken emails, own accounts and unknown ids with their codes", async () => {
    const taken = await expectProblem(
      await send("POST", "/staff-users", as(admin), { ...anna, email: "Admin@Example.org" }),
      422,
      "domain-error",
    );
    expect(taken.errors).toEqual([
      expect.objectContaining({ pointer: "/email", code: "email_taken" }),
    ]);
    const own = await expectProblem(
      await send("POST", `/staff-users/${admin}/deactivation`, as(admin)),
      422,
      "domain-error",
    );
    expect(own.errors?.map((e) => e.code)).toEqual(["own_account"]);
    const ownRole = await expectProblem(
      await send("PUT", `/staff-users/${admin}/org-roles`, as(admin), { orgRoles: [] }),
      422,
      "domain-error",
    );
    expect(ownRole.errors?.map((e) => e.code)).toEqual(["own_account"]);
    await expectProblem(
      await send("PATCH", `/staff-users/${werkNord}`, as(admin), { displayName: "X" }),
      404,
      "not-found",
    );
    const scope = await expectProblem(
      await send("PUT", `/staff-users/${consultant}/org-roles`, as(admin), {
        orgRoles: [{ role: "regional_admin", regionId: null }],
      }),
      400,
      "validation-error",
    );
    expect(scope.errors?.map((e) => e.code)).toEqual(["region_scope"]);
  });

  it("manages the regions", async () => {
    const created = await readJson(
      await send("POST", "/regions", as(admin), { code: "OST", name: "Niederlassung Ost" }),
      Region,
    );
    const renamed = await readJson(
      await send("PATCH", `/regions/${created.id}`, as(admin), { name: "Ost" }),
      Region,
    );
    expect(renamed).toMatchObject({ code: "OST", name: "Ost" });
    const taken = await expectProblem(
      await send("PATCH", `/regions/${created.id}`, as(admin), { code: "NORD" }),
      422,
      "domain-error",
    );
    expect(taken.errors).toEqual([
      expect.objectContaining({ pointer: "/code", code: "region_code_taken" }),
    ]);
    // Every staff user reads them (the region pickers)
    const regions = await readJson(await get("/regions", as(consultant)), z.array(Region));
    expect(regions.map((r) => r.code)).toEqual(["NORD", "OST", "SUED"]);
  });

  it("deactivates an account: its sessions end at once, it leaves every team", async () => {
    // An account of its own, so the shared consultant session stays live.
    const { id } = await readJson(
      await send("POST", "/staff-users", as(admin), {
        displayName: "Clara Coach",
        email: "clara@example.org",
      }),
      StaffAccount,
    );
    const clara = await login(app, id);
    await send("PUT", `/staff-users/${id}/org-roles`, as(admin), {
      orgRoles: [{ role: "regional_admin", regionId: seedRegionIds.nord }],
    });
    await send("POST", `/projects/${werkNord}/members`, as(projectLead), {
      staffUserId: id,
      role: "consultant",
    });
    const [a] = await participations(1);
    expect((await assign([a!], id)).status).toBe(200);
    expect((await get(`/participations/${a}`, clara)).status).toBe(200);
    const res = await send("POST", `/staff-users/${id}/deactivation`, as(admin));
    const deactivated = await readJson(res, StaffAccount);
    expect(deactivated.deactivatedAt).not.toBeNull();
    expect(deactivated.orgRoles).toEqual([]);
    await expectProblem(await get("/me", clara), 401, "unauthenticated");
    const team = await readJson(
      await get(`/projects/${werkNord}/members`, as(projectLead)),
      ProjectTeam,
    );
    expect(team.members.map((m) => m.staffUserId)).not.toContain(id);
    const detail = await readJson(
      await get(`/participations/${a}`, as(projectLead)),
      ParticipationDetail,
    );
    expect(detail.assignments).toEqual([]);
    await expectProblem(
      await app.request("/api/v1/dev/session", jsonRequest("POST", { staffUserId: id })),
      422,
      "domain-error",
    );
  });

  it("refuses to deactivate a project's last active PL", async () => {
    const res = await expectProblem(
      await send("POST", `/staff-users/${projectLead}/deactivation`, as(admin)),
      422,
      "domain-error",
    );
    expect(res.errors?.map((e) => e.code)).toEqual(["last_project_lead"]);
    expect((await get("/me", as(projectLead))).status).toBe(200);
  });
});

const teamMembers = async (projectId = werkNord) =>
  (await readJson(await get(`/projects/${projectId}/members`, as(projectLead)), ProjectTeam))
    .members;

describe("teams (Q61, Q126)", () => {
  it("are managed by the PL: add and remove roles, with capabilities", async () => {
    const team = await readJson(
      await get(`/projects/${werkNord}/members`, as(projectLead)),
      ProjectTeam,
    );
    expect(team.capabilities).toEqual({
      manageMembers: true,
      addReplacementLead: true,
      assignParticipations: true,
    });
    const added = await send("POST", `/projects/${werkNord}/members`, as(projectLead), {
      staffUserId: backOffice,
      role: "consultant",
    });
    expect(added.status).toBe(201);
    expect((await readJson(added, ProjectTeam)).members).toContainEqual(
      expect.objectContaining({ staffUserId: backOffice, roles: ["consultant", "back_office"] }),
    );
    expect(
      (await del(`/projects/${werkNord}/members/${backOffice}/back_office`, as(projectLead)))
        .status,
    ).toBe(204);
    expect(await teamMembers()).toContainEqual(
      expect.objectContaining({ staffUserId: backOffice, roles: ["consultant"] }),
    );
    await expectProblem(
      await del(`/projects/${werkNord}/members/${backOffice}/back_office`, as(projectLead)),
      404,
      "not-found",
    );
  });

  it("keep the last active PL", async () => {
    const res = await expectProblem(
      await del(`/projects/${werkNord}/members/${projectLead}/project_lead`, as(projectLead)),
      422,
      "domain-error",
    );
    expect(res.errors?.map((e) => e.code)).toEqual(["last_project_lead"]);
  });

  it("let a global admin add a replacement PL, never themselves; regional admins can't", async () => {
    const adminTeam = await readJson(
      await get(`/projects/${werkNord}/members`, as(admin)),
      ProjectTeam,
    );
    expect(adminTeam.capabilities).toEqual({
      manageMembers: false,
      addReplacementLead: true,
      assignParticipations: false,
    });
    const lead = { staffUserId: backOffice, role: "project_lead" };
    expect((await send("POST", `/projects/${werkNord}/members`, as(admin), lead)).status).toBe(201);
    await expectProblem(
      await send("POST", `/projects/${werkNord}/members`, as(admin), {
        staffUserId: admin,
        role: "project_lead",
      }),
      403,
      "forbidden",
    );
    await expectProblem(
      await send("POST", `/projects/${werkNord}/members`, as(admin), {
        staffUserId: consultant,
        role: "back_office",
      }),
      403,
      "forbidden",
    );
    await expectProblem(
      await send("POST", `/projects/${werkNord}/members`, as(regionalAdmin), lead),
      403,
      "forbidden",
    );
    await expectProblem(
      await del(`/projects/${werkNord}/members/${consultant}/consultant`, as(admin)),
      403,
      "forbidden",
    );
    // The replacement brought no case access: the admin still lists no participation
    await expectProblem(
      await get(`/projects/${werkNord}/participations`, as(admin)),
      403,
      "forbidden",
    );
  });

  it("are hidden from staff who can't see the project", async () => {
    await expectProblem(
      await get(`/projects/${lagerSued}/members`, as(regionalAdmin)),
      404,
      "not-found",
    );
  });

  it("are searched by name in the staff directory, by a PL or the admin", async () => {
    const found = await readJson(
      await get(`/staff-directory?search=${encodeURIComponent("beratung")}`, as(projectLead)),
      z.array(StaffDirectoryEntry),
    );
    expect(found).toEqual([{ id: consultant, displayName: "Bernd Beratung" }]);
    const wildcard = await readJson(
      await get("/staff-directory?search=%25", as(admin)),
      z.array(StaffDirectoryEntry),
    );
    expect(wildcard).toEqual([]);
    await expectProblem(await get("/staff-directory?search=a", as(consultant)), 403, "forbidden");
    await expectProblem(
      await get("/staff-directory?search=a", as(regionalAdmin)),
      403,
      "forbidden",
    );
  });
});

const listed = async (auth: Auth) =>
  (
    await readJson(
      await get(`/projects/${werkNord}/participations?limit=100`, auth),
      ParticipationPage,
    )
  ).items;

describe("assignments (Q62)", () => {
  it("give a consultant exactly their assigned participations, until unassigned", async () => {
    const [a, b, c] = await participations(3);
    await expectProblem(
      await get(`/projects/${werkNord}/participations`, as(consultant)),
      403,
      "forbidden",
    );
    const res = await assign([a!, b!]);
    expect(await readJson(res, AssignmentResult)).toEqual({ assigned: 2 });
    expect((await listed(as(consultant))).map((p) => p.id).toSorted()).toEqual([a, b].toSorted());
    expect((await get(`/participations/${a}`, as(consultant))).status).toBe(200);
    expect((await get(`/participations/${c}`, as(consultant))).status).toBe(403);
    // The PL sees the consultants in the list and the detail
    const items = await listed(as(projectLead));
    expect(items.find((p) => p.id === a)?.consultants).toEqual([
      expect.objectContaining({ staffUserId: consultant, displayName: "Bernd Beratung" }),
    ]);
    expect(items.find((p) => p.id === c)?.consultants).toEqual([]);
    const detail = await readJson(
      await get(`/participations/${a}`, as(projectLead)),
      ParticipationDetail,
    );
    expect(detail.assignments.map((x) => x.staffUserId)).toEqual([consultant]);
    expect(detail.capabilities.assignParticipations).toBe(true);
    // Unassigned: no access at the next request
    expect(
      (await del(`/participations/${a}/assignments/${consultant}`, as(projectLead))).status,
    ).toBe(204);
    expect((await get(`/participations/${a}`, as(consultant))).status).toBe(403);
    expect((await listed(as(consultant))).map((p) => p.id)).toEqual([b]);
    await expectProblem(
      await del(`/participations/${a}/assignments/${consultant}`, as(projectLead)),
      404,
      "not-found",
    );
  });

  it("go only to the project's consultants, by the PL", async () => {
    const [a] = await participations(1);
    const notConsultant = await expectProblem(await assign([a!], backOffice), 422, "domain-error");
    expect(notConsultant.errors).toEqual([
      expect.objectContaining({ pointer: "/staffUserId", code: "not_consultant" }),
    ]);
    const [elsewhere] = await participations(1, verwaltung);
    const other = await expectProblem(await assign([a!, elsewhere!]), 422, "domain-error");
    expect(other.errors?.map((e) => e.code)).toEqual(["participation_not_found"]);
    for (const user of [consultant, backOffice, admin, regionalAdmin]) {
      const status = (await assign([a!], consultant, as(user))).status;
      expect([user, status]).toEqual([user, 403]);
    }
    await expectProblem(
      await del(`/participations/${a}/assignments/${consultant}`, as(backOffice)),
      403,
      "forbidden",
    );
  });

  it("end when the consultant role goes", async () => {
    const [a] = await participations(1);
    await assign([a!]);
    expect(
      (await del(`/projects/${werkNord}/members/${consultant}/consultant`, as(projectLead))).status,
    ).toBe(204);
    await expectProblem(await get(`/participations/${a}`, as(consultant)), 404, "not-found");
    const detail = await readJson(
      await get(`/participations/${a}`, as(projectLead)),
      ParticipationDetail,
    );
    expect(detail.assignments).toEqual([]);
  });
});
