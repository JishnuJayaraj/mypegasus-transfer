import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  baseDefaultsDir,
  loadBaseDefaults,
  loadManifest,
  organisationFile,
  renderManifest,
  templatesDir,
} from "@transfer/config/load";
import {
  auditEvent,
  createDb,
  eq,
  project,
  projectMembership,
  projectTemplatePin,
  seedProjectIds,
  seedStaffUserIds,
  seedRegionIds,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { Project, ProjectConfig } from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedTemplatePins } from "./projects/seed";
import { loadRelease } from "./projects/template-pins";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// The project's configuration and its pins (regional-variation.md, template versions, snapshot).
const { app, db } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const auth: Record<string, { Cookie: string }> = {};
const { werkNord, lagerSued } = seedProjectIds;
const { templates: catalog } = loadManifest();
const baseDefaultsVersion = loadBaseDefaults().version;

const path = (projectId: string) => `/api/v1/projects/${projectId}/config`;
const get = (projectId: string, user = "projectLead", on = app) =>
  on.request(path(projectId), { headers: auth[user] });
const pin = (projectId: string, body: unknown, user = "projectLead", on = app) =>
  on.request(`${path(projectId)}/pins`, jsonRequest("POST", body, auth[user]));
const codes = async (res: Response, status = 422, type = "domain-error") =>
  (await expectProblem(res, status, type)).errors?.map(({ code, pointer }) => ({ code, pointer }));
const baseRelaxable = [
  "base-import-address",
  "base-import-birthDate",
  "base-import-firstName",
  "base-import-lastName",
  "base-import-oldEmploymentEndDate",
  "base-import-personnelNumber",
].map((ruleId) => ({ ruleId, step: "data_collection" }));
const prefixOf = (agenturKey: string, version: number) =>
  catalog.find((t) => t.agenturKey === agenturKey && t.version === version)!.sha256.slice(0, 12);

beforeAll(async () => {
  await resetTestDatabase({ seed: true });
  for (const user of Object.keys(seedStaffUserIds) as (keyof typeof seedStaffUserIds)[]) {
    auth[user] = await login(app, seedStaffUserIds[user]);
  }
});
beforeEach(() => resetTestDatabase({ seed: true }));
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

describe("GET /api/v1/projects/{projectId}/config", () => {
  it("shows a project without a Project Agentur as blocked (Q76, Q90)", async () => {
    const res = await get(lagerSued);
    expect(res.status).toBe(200);
    expect(await readJson(res, ProjectConfig)).toEqual({
      projectAgenturKey: null,
      baseDefaultsVersion,
      pins: [],
      projectBlockers: [{ code: "project_activation_blocked", agenturKey: null }],
      agenturen: [],
      activationBlockers: ["project_activation_blocked", "no_entry_wave_with_latest_entry_date"],
      override: { version: 0, agenturSettings: [], relaxations: [] },
      relaxationRequests: [],
      // The base-only chain's operational defaults (5.9, PR 2d-2).
      relaxableRules: baseRelaxable,
      capabilities: {
        pinTemplate: true,
        setProjectAgentur: true,
        changeOverride: true,
        requestRelaxation: true,
        activateProject: true,
        migrateTemplate: true,
        importParticipations: true,
        // Q126: the PL changes the region while draft.
        setProjectRegion: true,
        editKug200aHeader: true,
      },
    });
  });

  // Members and global org roles read the configuration (Q106), without pinning (round 26).
  it.each(["consultant", "backOffice", "admin", "regionalAdmin", "regionalOperationsManager"])(
    "is readable by %s, who may not pin",
    async (user) => {
      const res = await get(werkNord, user);
      expect(res.status).toBe(200);
      expect((await readJson(res, ProjectConfig)).capabilities).toEqual({
        pinTemplate: false,
        setProjectAgentur: false,
        changeOverride: false,
        requestRelaxation: false,
        activateProject: false,
        migrateTemplate: false,
        importParticipations: false,
        // Q126: only the global admin changes the region besides the PL.
        setProjectRegion: user === "admin",
        // The Kug 200a's header is the PL's (ba-forms.md, the Kug 200a as built).
        editKug200aHeader: false,
      });
    },
  );

  it("derives the capability from the current project: a PL elsewhere may not pin here", async () => {
    await owner.insert(projectMembership).values({
      projectId: werkNord,
      staffUserId: seedStaffUserIds.consultant,
      role: "project_lead",
    });
    const here = await readJson(await get(werkNord, "consultant"), ProjectConfig);
    expect(here.capabilities).toEqual({
      pinTemplate: true,
      setProjectAgentur: true,
      changeOverride: true,
      requestRelaxation: true,
      activateProject: true,
      migrateTemplate: true,
      importParticipations: true,
      setProjectRegion: true,
      editKug200aHeader: true,
    });
    const elsewhere = await readJson(await get(lagerSued, "consultant"), ProjectConfig);
    expect(elsewhere.capabilities).toEqual({
      pinTemplate: false,
      setProjectAgentur: false,
      changeOverride: false,
      requestRelaxation: false,
      activateProject: false,
      migrateTemplate: false,
      importParticipations: false,
      setProjectRegion: false,
      editKug200aHeader: false,
    });
    await expectProblem(
      await pin(lagerSued, { agenturKey: "beispielstadt-sued" }, "consultant"),
      403,
      "forbidden",
    );
  });

  it("is a 404 for a project the user can't see, and needs a session", async () => {
    const created = await app.request(
      "/api/v1/projects",
      jsonRequest(
        "POST",
        { name: "Neu", customerName: "Beispiel GmbH", type: "ta_tg", regionId: seedRegionIds.nord },
        auth.projectLead,
      ),
    );
    const { id } = await readJson(created, Project);
    await expectProblem(await get(id, "consultant"), 404, "not-found");
    await expectProblem(await get("00000000-0000-4000-9000-0000000000ff"), 404, "not-found");
    await expectProblem(await app.request(path(werkNord)), 401, "unauthenticated");
  });
});

describe("POST /api/v1/projects/{projectId}/config/pins (R12)", () => {
  it("pins the Project Agentur's latest version and sets it in one audited transaction", async () => {
    const res = await pin(werkNord, { agenturKey: "beispielstadt-nord", projectAgentur: true });
    expect(res.status).toBe(200);
    const config = await readJson(res, ProjectConfig);
    expect(config).toMatchObject({
      projectAgenturKey: "beispielstadt-nord",
      pins: [
        {
          agenturKey: "beispielstadt-nord",
          version: 3,
          label: { de: "Agentur für Arbeit Beispielstadt Nord (Beispiel)" },
          sha256Prefix: prefixOf("beispielstadt-nord", 3),
          pinnedBy: seedStaffUserIds.projectLead,
        },
      ],
      projectBlockers: [],
      agenturen: [{ agenturKey: "beispielstadt-nord", blockers: [], warnings: [] }],
      activationBlockers: [],
    });
    const events = await owner
      .select({
        type: auditEvent.eventType,
        details: auditEvent.details,
        requestId: auditEvent.requestId,
      })
      .from(auditEvent)
      .where(eq(auditEvent.projectId, werkNord))
      .orderBy(auditEvent.seq);
    expect(events.slice(-2)).toEqual([
      {
        type: "config_template_pinned",
        details: { agenturKey: "beispielstadt-nord", version: 3, baseDefaultsVersion },
        requestId: expect.any(String),
      },
      {
        type: "project_changed",
        details: { fields: ["projectAgenturKey"], projectAgenturKey: "beispielstadt-nord" },
        requestId: events.at(-2)!.requestId,
      },
    ]);
  });

  it("takes an older version the PL chooses, and pins further Agenturen without changing the Project Agentur", async () => {
    await pin(werkNord, { agenturKey: "beispielstadt-nord", version: 1, projectAgentur: true });
    const res = await pin(werkNord, { agenturKey: "beispielstadt-sued" });
    const config = await readJson(res, ProjectConfig);
    expect(config.projectAgenturKey).toBe("beispielstadt-nord");
    expect(config.pins.map((p) => `${p.agenturKey}@${p.version}`)).toEqual([
      "beispielstadt-nord@1",
      "beispielstadt-sued@1",
    ]);
    expect(config.agenturen.map((a) => a.agenturKey)).toEqual([
      "beispielstadt-nord",
      "beispielstadt-sued",
    ]);
    // A pinned further Agentur becomes the Project Agentur without a new pin (draft only).
    const changed = await readJson(
      await pin(werkNord, { agenturKey: "beispielstadt-sued", projectAgentur: true }),
      ProjectConfig,
    );
    expect(changed.projectAgenturKey).toBe("beispielstadt-sued");
    expect(await owner.$count(projectTemplatePin, eq(projectTemplatePin.projectId, werkNord))).toBe(
      2,
    );
  });

  it.each([
    [
      { agenturKey: "beispielstadt-ost" },
      [{ code: "template_not_in_catalog", pointer: "/agenturKey" }],
    ],
    [
      { agenturKey: "beispielstadt-sued", version: 2 },
      [{ code: "template_not_in_catalog", pointer: "/version" }],
    ],
  ])("chooses only from the catalog: %j", async (body, expected) => {
    expect(await codes(await pin(werkNord, body))).toEqual(expected);
  });

  it("leaves another version of a pinned Agentur to the migration, and refuses a repeat", async () => {
    await pin(werkNord, { agenturKey: "beispielstadt-nord", version: 1 });
    expect(
      await codes(await pin(werkNord, { agenturKey: "beispielstadt-nord", version: 2 })),
    ).toEqual([{ code: "template_already_pinned", pointer: "/version" }]);
    expect(await codes(await pin(werkNord, { agenturKey: "beispielstadt-nord" }))).toEqual([
      { code: "template_already_pinned", pointer: "/agenturKey" },
    ]);
  });

  it("fixes the Project Agentur once the project is active (R1, Q98)", async () => {
    await owner
      .update(project)
      .set({
        status: "active",
        activatedAt: "2026-10-17T08:00:00Z",
        activatedBy: seedStaffUserIds.projectLead,
      })
      .where(eq(project.id, lagerSued));
    const { capabilities } = await readJson(await get(lagerSued), ProjectConfig);
    expect(capabilities).toEqual({
      pinTemplate: true,
      setProjectAgentur: false,
      changeOverride: true,
      requestRelaxation: true,
      activateProject: false,
      migrateTemplate: true,
      importParticipations: true,
      // Active: the PL no longer changes the region (Q126), still the Kug 200a's header.
      setProjectRegion: false,
      editKug200aHeader: true,
    });
    expect(
      await codes(await pin(lagerSued, { agenturKey: "beispielstadt-sued", projectAgentur: true })),
    ).toEqual([{ code: "project_not_draft", pointer: "/projectAgentur" }]);
    expect((await pin(lagerSued, { agenturKey: "beispielstadt-sued" })).status).toBe(200);
  });

  it("takes strict input: never a client's content or hash", async () => {
    const body = await expectProblem(
      await pin(werkNord, { agenturKey: "beispielstadt-nord", sha256: "0".repeat(64) }),
      400,
      "validation-error",
    );
    expect(body.errors).toEqual([
      { pointer: "/sha256", code: "unrecognized_keys", detail: "Unknown field" },
    ]);
    await expectProblem(await pin(werkNord, { agenturKey: "Nord" }), 400, "validation-error");
  });

  // pinTemplate is the PL's operation (5.4); a project the user can't see is a 404.
  it.each(["consultant", "backOffice", "admin", "regionalOperationsManager"])(
    "is forbidden to %s",
    async (user) => {
      await expectProblem(
        await pin(werkNord, { agenturKey: "beispielstadt-nord" }, user),
        403,
        "forbidden",
      );
    },
  );

  it("is a 404 for an unknown project", async () => {
    const res = await pin("00000000-0000-4000-9000-0000000000ff", {
      agenturKey: "beispielstadt-nord",
    });
    await expectProblem(res, 404, "not-found");
  });
});

/** A CONFIG_DIR as the build writes it, with `beispielstadt-nord@1` changed by `change`. */
function changedConfigDir(change: (template: Record<string, unknown>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "config-dir-"));
  cpSync(fileURLToPath(templatesDir), join(dir, "templates"), { recursive: true });
  cpSync(
    fileURLToPath(new URL("base-defaults.json", baseDefaultsDir)),
    join(dir, "base-defaults.json"),
  );
  cpSync(fileURLToPath(organisationFile), join(dir, "organisation.json"));
  const file = join(dir, "templates/beispielstadt-nord/1.json");
  const template = JSON.parse(readFileSync(file, "utf8"));
  change(template);
  writeFileSync(file, JSON.stringify(template));
  const templates = new URL(`file://${dir}/templates/`);
  writeFileSync(join(dir, "templates/manifest.json"), renderManifest(templates));
  return dir;
}

describe("the snapshot (AC-10, AC-11)", () => {
  const withoutLeadTime = changedConfigDir((template) => {
    delete (template.settings as { agentur_submission: Record<string, unknown> }).agentur_submission
      .leadTimeDays;
  });
  const changed = testApp({ db, env: { configDir: withoutLeadTime } }).app;

  it("resolves a pinned project only from the stored content: a changed file changes nothing", async () => {
    await pin(werkNord, { agenturKey: "beispielstadt-nord", version: 1, projectAgentur: true });
    const before = await readJson(await get(werkNord), ProjectConfig);
    const after = await readJson(await get(werkNord, "projectLead", changed), ProjectConfig);
    expect(after).toEqual(before);
    expect(after.agenturen).toEqual([
      { agenturKey: "beispielstadt-nord", blockers: [], warnings: [] },
    ]);
  });

  it("refuses the changed file for every later pin of that version, in any project", async () => {
    await pin(werkNord, { agenturKey: "beispielstadt-nord", version: 1 });
    expect(
      await codes(
        await pin(
          lagerSued,
          { agenturKey: "beispielstadt-nord", version: 1 },
          "projectLead",
          changed,
        ),
      ),
    ).toEqual([{ code: "template_version_changed", pointer: "" }]);
  });

  it("shows the participant-level blockers of a pinned Agentur, by step (Q92)", async () => {
    // First registered from the changed file (another database state; the file was never pinned).
    await pin(
      lagerSued,
      { agenturKey: "beispielstadt-nord", version: 1, projectAgentur: true },
      "projectLead",
      changed,
    );
    const config = await readJson(await get(lagerSued), ProjectConfig);
    const blocker = {
      code: "agentur_submission_blocked",
      step: "agentur_submission",
      agenturKey: "beispielstadt-nord",
      missing: ["leadTimeDays"],
    };
    expect(config.agenturen).toEqual([
      { agenturKey: "beispielstadt-nord", blockers: [blocker], warnings: [blocker] },
    ]);
    expect(config.projectBlockers).toEqual([]);
    expect(config.activationBlockers).toEqual(["no_entry_wave_with_latest_entry_date"]);
  });

  it("refuses a stored version that isn't its own snapshot (500)", async () => {
    await pin(werkNord, { agenturKey: "beispielstadt-nord", version: 1 });
    await owner.$client.query(
      "alter table config_template_version disable trigger config_template_version_append_only",
    );
    try {
      await owner.$client.query(
        `update config_template_version set content_sha256 = '${"0".repeat(64)}'`,
      );
    } finally {
      await owner.$client.query(
        "alter table config_template_version enable trigger config_template_version_append_only",
      );
    }
    await expectProblem(await get(werkNord), 500, "internal-error");
  });
});

describe("the seed's pins (plan 5.5)", () => {
  it("pins through the service, idempotently", async () => {
    const release = loadRelease(undefined);
    await seedTemplatePins(db, release);
    await seedTemplatePins(db, release);
    const pins = await owner
      .select({ projectId: projectTemplatePin.projectId, key: projectTemplatePin.agenturKey })
      .from(projectTemplatePin)
      .orderBy(projectTemplatePin.seq);
    expect(pins).toEqual([
      { projectId: werkNord, key: "beispielstadt-nord" },
      { projectId: werkNord, key: "beispielstadt-sued" },
      { projectId: seedProjectIds.verwaltung, key: "beispielstadt-sued" },
    ]);
    const [nord] = await owner
      .select({ key: project.projectAgenturKey })
      .from(project)
      .where(eq(project.id, werkNord));
    expect(nord).toEqual({ key: "beispielstadt-nord" });
  });
});
