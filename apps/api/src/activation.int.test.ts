import { canonicalHash, loadBaseDefaults, loadTemplate } from "@transfer/config/load";
import {
  and,
  auditEvent,
  configTemplateVersion,
  createDb,
  eq,
  project,
  projectMembership,
  projectTemplatePin,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { Project, ProjectActivation, ProjectConfig } from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedTemplatePins } from "./projects/seed";
import { loadRelease } from "./projects/template-pins";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// Slice 2 plan 5.3, 5.4, 5.5 and 5.12 (PR 2e-1): activating a draft project (AC-17, AC-45).
const { app, db } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const auth: Record<string, { Cookie: string }> = {};
const { werkNord, lagerSued, verwaltung } = seedProjectIds;
const baseDefaultsVersion = loadBaseDefaults().version;

const activate = (projectId: string, user = "projectLead", body: unknown = {}) =>
  app.request(`/api/v1/projects/${projectId}/activation`, jsonRequest("POST", body, auth[user]));
const config = async (projectId: string, user = "projectLead") =>
  readJson(
    await app.request(`/api/v1/projects/${projectId}/config`, { headers: auth[user] }),
    ProjectConfig,
  );
const codes = async (res: Response) =>
  (await expectProblem(res, 422, "domain-error")).errors?.map(({ code }) => code);
const statusOf = async (projectId: string) =>
  (await owner.select({ status: project.status }).from(project).where(eq(project.id, projectId)))[0]
    ?.status;
const activations = (projectId: string) =>
  owner
    .select({ actor: auditEvent.actorStaffUserId, details: auditEvent.details })
    .from(auditEvent)
    .where(eq(auditEvent.projectId, projectId))
    .then((rows) => rows.filter((row) => "projectAgenturVersion" in (row.details as object)));

/**
 * A synthetic Agentur whose template records no Agentur-submission settings, pinned directly as
 * the owner (round 27): every sample template records them all, so none would give a warning.
 */
async function pinIncompleteAgentur(projectId: string) {
  const sued = loadTemplate("beispielstadt-sued", 1) as Record<string, unknown>;
  const settings = sued.settings as Record<string, unknown>;
  const content = {
    ...sued,
    id: "beispielstadt-test",
    agenturKey: "beispielstadt-test",
    settings: { asu_registration: settings.asu_registration },
  };
  await owner.insert(configTemplateVersion).values({
    agenturKey: "beispielstadt-test",
    version: 1,
    content,
    contentSha256: canonicalHash(content),
  });
  await owner.insert(projectTemplatePin).values({
    projectId,
    agenturKey: "beispielstadt-test",
    version: 1,
    pinnedBy: seedStaffUserIds.projectLead,
  });
}

beforeAll(async () => {
  await resetTestDatabase({ seed: true });
  for (const user of Object.keys(seedStaffUserIds) as (keyof typeof seedStaffUserIds)[]) {
    auth[user] = await login(app, seedStaffUserIds[user]);
  }
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true });
  // Werk Nord: Project Agentur beispielstadt-nord@1 and beispielstadt-sued@1; Verwaltung:
  // beispielstadt-sued@1; Lager Süd: nothing (plan 5.5).
  await seedTemplatePins(db, loadRelease(undefined));
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

describe("POST /api/v1/projects/{projectId}/activation (AC-17)", () => {
  it("activates a draft project, returns the submission blockers as warnings and audits the base-defaults version (AC-45)", async () => {
    await pinIncompleteAgentur(werkNord);
    expect((await config(werkNord)).capabilities.activateProject).toBe(true);
    const res = await activate(werkNord);
    expect(res.status).toBe(200);
    const activation = await readJson(res, ProjectActivation);
    expect(activation.status).toBe("active");
    // Agentur-submission blockers never block (Q91, Q92), each with its Agentur and step.
    expect(activation.warnings).toEqual([
      {
        code: "agentur_submission_blocked",
        step: "agentur_submission",
        agenturKey: "beispielstadt-test",
        missing: [
          "submissionChannel",
          "originalRequired",
          "leadTimeDays",
          "rejectsOutdatedFormVersions",
        ],
      },
    ]);
    const shown = await readJson(
      await app.request(`/api/v1/projects/${werkNord}`, { headers: auth.projectLead }),
      Project,
    );
    expect(shown).toMatchObject({ status: "active", activatedAt: activation.activatedAt });
    expect(await activations(werkNord)).toEqual([
      {
        actor: seedStaffUserIds.projectLead,
        details: {
          projectAgenturKey: "beispielstadt-nord",
          projectAgenturVersion: 1,
          baseDefaultsVersion,
        },
      },
    ]);
    // One-way (R1): no activation and no Project Agentur choice once active.
    const { capabilities } = await config(werkNord);
    expect(capabilities).toMatchObject({ activateProject: false, setProjectAgentur: false });
    expect(await codes(await activate(werkNord))).toEqual(["project_not_draft"]);
  });

  it("needs no wave in a ta_only project and returns no warning when nothing is missing", async () => {
    const res = await activate(verwaltung);
    expect(res.status).toBe(200);
    expect((await readJson(res, ProjectActivation)).warnings).toEqual([]);
  });

  it("refuses with exactly the blockers projectActivationBlockers names, writing nothing", async () => {
    expect((await config(lagerSued)).activationBlockers).toEqual([
      "project_activation_blocked",
      "no_entry_wave_with_latest_entry_date",
    ]);
    expect(await codes(await activate(lagerSued))).toEqual([
      "project_activation_blocked",
      "no_entry_wave_with_latest_entry_date",
    ]);
    const pinned = await app.request(
      `/api/v1/projects/${lagerSued}/config/pins`,
      jsonRequest(
        "POST",
        { agenturKey: "beispielstadt-sued", projectAgentur: true },
        auth.projectLead,
      ),
    );
    expect(pinned.status).toBe(200);
    expect(await codes(await activate(lagerSued))).toEqual([
      "no_entry_wave_with_latest_entry_date",
    ]);
    expect(await statusOf(lagerSued)).toBe("draft");
    expect(await activations(lagerSued)).toEqual([]);
  });

  it("is the project's PL's: 404 for a project the user can't see, 403 for other roles, before the blockers", async () => {
    // Lager Süd has blockers, so a 422 would leak past the access checks (round 27/28 order).
    for (const user of [
      "consultant",
      "backOffice",
      "admin",
      "regionalAdmin",
      "regionalOperationsManager",
    ]) {
      await expectProblem(await activate(lagerSued, user), 403, "forbidden");
      expect((await config(lagerSued, user)).capabilities.activateProject).toBe(false);
    }
    await owner
      .delete(projectMembership)
      .where(
        and(
          eq(projectMembership.projectId, lagerSued),
          eq(projectMembership.staffUserId, seedStaffUserIds.consultant),
        ),
      );
    await expectProblem(await activate(lagerSued, "consultant"), 404, "not-found");
    await expectProblem(await activate("00000000-0000-4000-9000-0000000000ff"), 404, "not-found");
    const anonymous = await app.request(
      `/api/v1/projects/${lagerSued}/activation`,
      jsonRequest("POST", {}),
    );
    expect(anonymous.status).toBe(401);
    expect(await statusOf(lagerSued)).toBe("draft");
  });

  it("takes strict input", async () => {
    const body = await expectProblem(
      await activate(verwaltung, "projectLead", { force: true }),
      400,
      "validation-error",
    );
    expect(body.errors).toEqual([
      { pointer: "/force", code: "unrecognized_keys", detail: "Unknown field" },
    ]);
    expect(await statusOf(verwaltung)).toBe("draft");
  });
});
