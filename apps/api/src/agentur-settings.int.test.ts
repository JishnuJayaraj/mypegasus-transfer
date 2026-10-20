import { ManualClock } from "@transfer/adapters";
import { canonicalHash, loadTemplate } from "@transfer/config/load";
import {
  auditEvent,
  createDb,
  eq,
  projectConfigOverride,
  seedProjectIds,
  seedRegionIds,
  seedStaffUserIds,
  sql,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { ProjectConfig } from "@transfer/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditContext } from "./sql";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// Slice 2 plan 5.3, 5.4, 5.9 and 5.12 (PR 2d-1): Agentur-scoped settings as override versions
// (round 8, Q93, R14; AC-14, AC-16).
const { app, db } = testApp({ clock: new ManualClock(new Date("2026-10-17T10:00:00Z")) });
const owner = createDb(testDatabaseUrls().owner);
const auth: Record<string, { Cookie: string }> = {};
const { werkNord, lagerSued } = seedProjectIds;
const nord = "beispielstadt-nord";
const sued = "beispielstadt-sued";
const ost = "beispielstadt-ost"; // no template in the catalog

const configPath = (projectId: string) => `/api/v1/projects/${projectId}/config`;
const settingPath = (projectId: string, key: string) =>
  `${configPath(projectId)}/agentur-settings/${key}`;
const body = (expectedVersion: number, extra: object = {}) => ({
  expectedVersion,
  settings: { agentur_submission: { leadTimeDays: 5 } },
  source: "phone_call_agentur",
  confirmedOn: "2026-10-17",
  ...extra,
});
const put = (projectId: string, key: string, payload: unknown, user = "projectLead") =>
  app.request(settingPath(projectId, key), jsonRequest("PUT", payload, auth[user]));
const remove = (projectId: string, key: string, query: string, user = "projectLead") =>
  app.request(`${settingPath(projectId, key)}?${query}`, {
    method: "DELETE",
    headers: { ...auth[user], Origin: "http://localhost:5173" },
  });
const pin = (projectId: string, payload: unknown) =>
  app.request(`${configPath(projectId)}/pins`, jsonRequest("POST", payload, auth.projectLead));
const codes = async (res: Response, status = 422, type = "domain-error") =>
  (await expectProblem(res, status, type)).errors?.map(({ code, pointer }) => ({ code, pointer }));

/** Pins `nord@1` without its `leadTimeDays` (a synthetic content with its own hash). */
async function pinNordWithoutLeadTime(projectId: string) {
  const template = structuredClone(loadTemplate(nord, 1)) as {
    settings: { agentur_submission: Record<string, unknown> };
  };
  delete template.settings.agentur_submission.leadTimeDays;
  await owner.execute(sql`select pin_agentur_template(p_project_id => ${projectId}::uuid,
    p_agentur_key => ${nord}, p_version => 1, p_content => ${JSON.stringify(template)}::jsonb,
    p_sha256 => ${canonicalHash(template)}, p_base_defaults_version => 1,
    p_context => ${auditContext(seedStaffUserIds.projectLead, null)})`);
}

beforeAll(async () => {
  await resetTestDatabase({ seed: true });
  for (const user of Object.keys(seedStaffUserIds) as (keyof typeof seedStaffUserIds)[]) {
    auth[user] = await login(app, seedStaffUserIds[user]);
  }
});
beforeEach(() => resetTestDatabase({ seed: true }));
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

describe("PUT …/config/agentur-settings/{agenturKey} (AC-14)", () => {
  it("wins per key for its own Agentur only, as a new audited override version", async () => {
    await pinNordWithoutLeadTime(werkNord);
    await pin(werkNord, { agenturKey: sued });
    const before = await readJson(
      await app.request(configPath(werkNord), { headers: auth.projectLead }),
      ProjectConfig,
    );
    expect(before.agenturen.find((a) => a.agenturKey === nord)!.blockers).toEqual([
      expect.objectContaining({ step: "agentur_submission", missing: ["leadTimeDays"] }),
    ]);

    const res = await put(werkNord, nord, body(0));
    expect(res.status).toBe(200);
    const config = await readJson(res, ProjectConfig);
    expect(config.override).toEqual({
      version: 1,
      agenturSettings: [
        {
          agenturKey: nord,
          settings: { agentur_submission: { leadTimeDays: 5 } },
          source: "phone_call_agentur",
          confirmedBy: seedStaffUserIds.projectLead,
          confirmedOn: "2026-10-17",
        },
      ],
      relaxations: [],
    });
    // The snapshot resolves with the override (R11): Nord's missing key is supplied; Süd keeps
    // its template's values and blockers.
    expect(config.agenturen).toEqual([
      { agenturKey: nord, blockers: [], warnings: [] },
      { agenturKey: sued, blockers: [], warnings: [] },
    ]);
    const events = await owner
      .select({ type: auditEvent.eventType, details: auditEvent.details })
      .from(auditEvent)
      .where(eq(auditEvent.eventType, "config_override_changed"));
    expect(events).toEqual([
      {
        type: "config_override_changed",
        details: {
          version: 1,
          change: "agentur_setting_set",
          agenturKey: nord,
          settingKeys: ["agentur_submission.leadTimeDays"],
          source: "phone_call_agentur",
          baseDefaultsVersion: 1,
        },
      },
    ]);
  });

  it("takes an Agentur without a template (the fallback case), replaces a setting, and refuses an unchanged one", async () => {
    expect((await put(lagerSued, ost, body(0))).status).toBe(200);
    const res = await put(lagerSued, ost, body(1, { source: "letter_agentur" }));
    expect((await readJson(res, ProjectConfig)).override).toMatchObject({
      version: 2,
      agenturSettings: [{ agenturKey: ost, source: "letter_agentur" }],
    });
    expect(await codes(await put(lagerSued, ost, body(2, { source: "letter_agentur" })))).toEqual([
      { code: "override_unchanged", pointer: "" },
    ]);
  });

  it("refuses a stale expected version with a 409 (optimistic concurrency)", async () => {
    await put(lagerSued, ost, body(0));
    await expectProblem(await put(lagerSued, nord, body(0)), 409, "conflict");
    await expectProblem(await put(lagerSued, nord, body(5)), 409, "conflict");
    expect(await owner.$count(projectConfigOverride)).toBe(1);
  });

  it("needs a confirmation by today and at least one setting (R14)", async () => {
    expect(
      await codes(await put(lagerSued, ost, body(0, { settings: {}, confirmedOn: "2026-10-18" }))),
    ).toEqual([
      { code: "settings_empty", pointer: "/settings" },
      { code: "confirmed_on_in_future", pointer: "/confirmedOn" },
    ]);
  });

  it("takes strict input: the confirmer is always the acting user", async () => {
    const problem = await expectProblem(
      await put(lagerSued, ost, body(0, { confirmedBy: seedStaffUserIds.admin })),
      400,
      "validation-error",
    );
    expect(problem.errors).toEqual([
      { pointer: "/confirmedBy", code: "unrecognized_keys", detail: "Unknown field" },
    ]);
    await expectProblem(await put(lagerSued, "Ost", body(0)), 400, "validation-error");
    await expectProblem(
      await put(lagerSued, ost, body(0, { source: "rumour" })),
      400,
      "validation-error",
    );
  });

  // changeOverride is the PL's operation (5.4); a project the user can't see is a 404.
  it.each(["consultant", "backOffice", "admin", "regionalOperationsManager"])(
    "is forbidden to %s",
    async (user) => {
      await expectProblem(await put(werkNord, ost, body(0), user), 403, "forbidden");
      await expectProblem(await remove(werkNord, ost, "expectedVersion=0", user), 403, "forbidden");
    },
  );

  it("is a 404 for an unknown project", async () => {
    const unknown = "00000000-0000-4000-9000-0000000000ff";
    await expectProblem(await put(unknown, ost, body(0)), 404, "not-found");
  });

  // Round 27: visibility and the operation come before the setting's rules, so an unauthorised
  // caller never learns them from a 422.
  it("checks access before the setting's rules: 403 and 404 for invalid data too", async () => {
    const invalid = body(0, { settings: {}, confirmedOn: "2026-10-18" });
    await expectProblem(await put(werkNord, ost, invalid, "consultant"), 403, "forbidden");
    const created = await app.request(
      "/api/v1/projects",
      jsonRequest(
        "POST",
        { name: "Neu", customerName: "Beispiel GmbH", type: "ta_tg", regionId: seedRegionIds.nord },
        auth.projectLead,
      ),
    );
    const { id } = (await created.json()) as { id: string };
    await expectProblem(await put(id, ost, invalid, "consultant"), 404, "not-found");
    const unknown = "00000000-0000-4000-9000-0000000000ff";
    await expectProblem(await put(unknown, ost, invalid), 404, "not-found");
  });
});

describe("DELETE …/config/agentur-settings/{agenturKey}", () => {
  it("removes the setting as a new version; the blocker it lifted returns", async () => {
    await pinNordWithoutLeadTime(werkNord);
    await put(werkNord, nord, body(0));
    const res = await remove(werkNord, nord, "expectedVersion=1");
    expect(res.status).toBe(200);
    const config = await readJson(res, ProjectConfig);
    expect(config.override).toEqual({ version: 2, agenturSettings: [], relaxations: [] });
    expect(config.agenturen[0]!.blockers).toEqual([
      expect.objectContaining({ missing: ["leadTimeDays"] }),
    ]);
    const [event] = await owner
      .select({ details: auditEvent.details })
      .from(auditEvent)
      .where(eq(auditEvent.eventType, "config_override_changed"))
      .orderBy(sql`${auditEvent.seq} desc`)
      .limit(1);
    expect(event!.details).toEqual({
      version: 2,
      change: "agentur_setting_removed",
      agenturKey: nord,
      settingKeys: ["agentur_submission.leadTimeDays"],
      baseDefaultsVersion: 1,
    });
  });

  it("is a 404 without such a setting, a 409 when stale, a 400 without a version", async () => {
    await expectProblem(await remove(lagerSued, ost, "expectedVersion=0"), 404, "not-found");
    await put(lagerSued, ost, body(0));
    await expectProblem(await remove(lagerSued, ost, "expectedVersion=0"), 409, "conflict");
    await expectProblem(await remove(lagerSued, ost, ""), 400, "validation-error");
    await expectProblem(
      await remove(lagerSued, ost, "expectedVersion=1&force=1"),
      400,
      "validation-error",
    );
  });
});

describe("the override across every pinned chain (5.9, AC-16)", () => {
  it("refuses a pin that would make the current override invalid, with the issues", async () => {
    // An override field that Nord's template declares too: a synthetic state inserted as the
    // owner, since no function writes override fields before the admin UI (R13, round 27).
    const content = {
      schemaVersion: 1,
      kind: "project_override",
      fields: {
        "custom.beispiel_zusatznachweis_nr": {
          type: "string",
          maxLength: 40,
          "x-dataClass": "confidential",
          "x-retentionClass": "participation_record",
          "x-label": { de: "Nachweis" },
        },
      },
      agenturSettings: {
        [ost]: {
          settings: { agentur_submission: { leadTimeDays: 5 } },
          source: "email_agentur",
          confirmedBy: seedStaffUserIds.projectLead,
          confirmedOn: "2026-10-16",
        },
      },
    };
    await owner.insert(projectConfigOverride).values({
      projectId: lagerSued,
      version: 1,
      content,
      createdBy: seedStaffUserIds.projectLead,
    });
    expect((await pin(lagerSued, { agenturKey: sued })).status).toBe(200);
    expect(await codes(await pin(lagerSued, { agenturKey: nord }))).toEqual([
      { code: "override_invalid", pointer: "" },
      { code: "field_redefined", pointer: "" },
    ]);
  });
});
