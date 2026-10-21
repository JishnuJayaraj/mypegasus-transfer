import { loadBaseDefaults } from "@transfer/config/load";
import {
  and,
  auditEvent,
  eq,
  participation,
  projectConfigOverride,
  projectTemplatePin,
  seedProjectIds,
  seedStaffUserIds,
  sql,
} from "@transfer/db";
import { ParticipationDetail, ParticipationPage } from "@transfer/domain";
import { describe, expect, it } from "vitest";
import { app, auth, codes, owner, werkNord } from "./imports/import-testing";
import { expectProblem, jsonRequest, readJson } from "./testing";

// Version 2 adds the TL 407 rules (regional-variation.md, base defaults).
const baseDefaultsVersion = loadBaseDefaults().version;

// Q139 (regional-variation.md, "Placement Agentur"): the PL or back office set a participation's
// placement Agentur; an unpinned catalog Agentur is pinned at its latest version in the same
// transaction, and the participation resolves its own chain.

const { lagerSued } = seedProjectIds;
const person = (personnelNumber: string) => ({
  personnelNumber,
  lastName: "Beispiel",
  firstName: "Bernd",
  birthDate: "01.01.1970",
  oldEmploymentEndDate: "31.12.2026",
  addressStreet: "Musterstraße 100",
  addressPostalCode: "99999",
  addressCity: "Beispielstadt",
  mobile: "0171 3920099",
});

/** A participation created by hand by the PL (Werk Nord unless named). */
async function created(projectId: string = werkNord, personnelNumber = "BSP-0100") {
  const res = await app.request(
    `/api/v1/projects/${projectId}/participations`,
    jsonRequest("POST", { values: person(personnelNumber) }, auth.projectLead),
  );
  expect(res.status).toBe(201);
  return (await readJson(res, ParticipationDetail)).id;
}

const place = (id: string, agenturKey: string, user = "projectLead") =>
  app.request(
    `/api/v1/participations/${id}/placement-agentur`,
    jsonRequest("PUT", { agenturKey }, auth[user]),
  );
const detail = async (id: string, user = "projectLead") =>
  readJson(
    await app.request(`/api/v1/participations/${id}`, { headers: auth[user] }),
    ParticipationDetail,
  );

const pinsOf = async (projectId: string) =>
  (
    await owner
      .select({ agenturKey: projectTemplatePin.agenturKey, version: projectTemplatePin.version })
      .from(projectTemplatePin)
      .where(eq(projectTemplatePin.projectId, projectId))
      .orderBy(projectTemplatePin.seq)
  ).map(({ agenturKey, version }) => `${agenturKey}@${version}`);

const eventsOf = async (
  projectId: string,
  type: "placement_agentur_set" | "config_template_pinned",
) =>
  (
    await owner
      .select({ participationId: auditEvent.participationId, details: auditEvent.details })
      .from(auditEvent)
      .where(and(eq(auditEvent.projectId, projectId), eq(auditEvent.eventType, type)))
      .orderBy(auditEvent.seq)
  ).map(({ participationId, details }) => ({ participationId, details }));

/** The participant-level blockers as code, step and Agentur. */
const blockedBy = (body: ParticipationDetail) =>
  body.submissionBlockers.map((b) => [b.code, "step" in b ? b.step : null, b.agenturKey]);

describe("PUT /api/v1/participations/{participationId}/placement-agentur (Q139)", () => {
  it("pins an unpinned catalog Agentur at its latest version and sets the key, audited", async () => {
    const id = await created(lagerSued);
    const res = await place(id, "beispielstadt-nord");
    const body = await readJson(res, ParticipationDetail);
    expect(res.status).toBe(200);
    expect(body.placementAgenturKey).toBe("beispielstadt-nord");
    expect(body.placementAgenturSetAt).toMatch(/Z$/);
    expect(await pinsOf(lagerSued)).toEqual(["beispielstadt-nord@3"]);
    const pinned = await eventsOf(lagerSued, "config_template_pinned");
    expect(pinned.at(-1)).toEqual({
      participationId: null,
      details: { agenturKey: "beispielstadt-nord", version: 3, baseDefaultsVersion },
    });
    expect(await eventsOf(lagerSued, "placement_agentur_set")).toEqual([
      {
        participationId: id,
        details: { agenturKey: "beispielstadt-nord", baseDefaultsVersion },
      },
    ]);
    // The choices now offer the project's pin.
    expect(body.placementAgenturChoices).toContainEqual({
      agenturKey: "beispielstadt-nord",
      label: expect.objectContaining({ de: expect.any(String) }),
      pinnedVersion: 3,
      latestVersion: 3,
    });
  });

  it("uses the project's pin of an Agentur it has pinned, and back office may change it", async () => {
    const id = await created();
    const before = await pinsOf(werkNord);
    expect(before).toContain("beispielstadt-nord@1");
    expect((await place(id, "beispielstadt-nord")).status).toBe(200);
    expect((await place(id, "beispielstadt-sued", "backOffice")).status).toBe(200);
    expect(await pinsOf(werkNord)).toEqual(before);
    expect((await eventsOf(werkNord, "placement_agentur_set")).map((e) => e.details)).toEqual([
      { agenturKey: "beispielstadt-nord", baseDefaultsVersion },
      {
        agenturKey: "beispielstadt-sued",
        previousAgenturKey: "beispielstadt-nord",
        baseDefaultsVersion,
      },
    ]);
  });

  it("accepts a key without a template; that participation's Agentur submission stays blocked", async () => {
    const id = await created();
    // Unplaced, the base-only chain knows no submission settings (Q76).
    expect(blockedBy(await detail(id))).toEqual([
      ["agentur_submission_blocked", "asu_registration", null],
      ["agentur_submission_blocked", "agentur_submission", null],
    ]);
    // Süd's pinned template has them all.
    expect(
      blockedBy(await readJson(await place(id, "beispielstadt-sued"), ParticipationDetail)),
    ).toEqual([]);
    const res = await place(id, "ohne-vorlage");
    const body = await readJson(res, ParticipationDetail);
    expect(body.placementAgenturKey).toBe("ohne-vorlage");
    expect(blockedBy(body)).toEqual([
      ["agentur_submission_blocked", "asu_registration", "ohne-vorlage"],
      ["agentur_submission_blocked", "agentur_submission", "ohne-vorlage"],
    ]);
    expect(await pinsOf(werkNord)).not.toContain(expect.stringMatching(/^ohne-vorlage/));
  });

  it("refuses both the pin and the key when the override wouldn't validate with the template", async () => {
    // Valid without a pin; version 2 of Nord brings a rule of the same id, as in the migration test. Override
    // rules have no API, so the state is inserted as the owner.
    const rule = { id: "beispielstadt-nord-mobile", kind: "required", field: "mobile" };
    await owner.insert(projectConfigOverride).values({
      projectId: lagerSued,
      version: 1,
      content: { schemaVersion: 1, kind: "project_override", rules: { data_collection: [rule] } },
      createdBy: seedStaffUserIds.projectLead,
    });
    const id = await created(lagerSued);
    expect(await codes(await place(id, "beispielstadt-nord"))).toEqual([
      "override_invalid",
      "rule_redefined",
    ]);
    expect(await pinsOf(lagerSued)).toEqual([]);
    expect((await detail(id)).placementAgenturKey).toBeNull();
  });

  it("refuses the same key again and a terminal participation", async () => {
    const id = await created();
    await place(id, "beispielstadt-sued");
    expect(await codes(await place(id, "beispielstadt-sued"))).toEqual([
      "placement_agentur_unchanged",
    ]);
    // A fixture written as the owner: the project is a draft, where no status changes.
    await owner.execute(
      sql`update participation set status = 'withdrawn', end_reason = 'other',
        end_reason_source = 'user', withdrawn_on = '2026-10-21' where id = ${id}::uuid`,
    );
    expect(await codes(await place(id, "beispielstadt-nord"))).toEqual(["participation_closed"]);
    expect((await detail(id)).capabilities.setPlacementAgentur).toBe(false);
  });

  it("is for the PL and back office only (403), and hides other projects' participations (404)", async () => {
    const id = await created();
    await expectProblem(await place(id, "beispielstadt-sued", "consultant"), 403, "forbidden");
    await expectProblem(await place(id, "beispielstadt-sued", "admin"), 403, "forbidden");
    await expectProblem(
      await place(id, "beispielstadt-sued", "regionalOperationsManager"),
      403,
      "forbidden",
    );
    await expectProblem(await place(crypto.randomUUID(), "beispielstadt-sued"), 404, "not-found");
    const [row] = await owner
      .select({ key: participation.placementAgenturKey })
      .from(participation)
      .where(eq(participation.id, id));
    expect(row!.key).toBeNull();
  });

  it("validates the key's format and refuses any other field (400)", async () => {
    const id = await created();
    for (const body of [{ agenturKey: "Agentur Nord" }, { agenturKey: "nord", version: 1 }, {}]) {
      const res = await app.request(
        `/api/v1/participations/${id}/placement-agentur`,
        jsonRequest("PUT", body, auth.projectLead),
      );
      await expectProblem(res, 400, "validation-error");
    }
  });
});

describe("the placement Agentur in the detail and the list (Q139)", () => {
  it("offers the choices to the PL and back office, the capability per role", async () => {
    const id = await created();
    const pl = await detail(id);
    expect(pl.capabilities.setPlacementAgentur).toBe(true);
    expect(
      pl.placementAgenturChoices.map((c) => [c.agenturKey, c.pinnedVersion, c.latestVersion]),
    ).toEqual([
      ["beispielstadt-nord", 1, 3],
      ["beispielstadt-sued", 1, 1],
    ]);
    expect((await detail(id, "backOffice")).capabilities.setPlacementAgentur).toBe(true);
  });

  it("lists the key with the case data", async () => {
    const id = await created();
    await place(id, "beispielstadt-sued");
    const page = await readJson(
      await app.request(`/api/v1/projects/${werkNord}/participations`, {
        headers: auth.backOffice,
      }),
      ParticipationPage,
    );
    expect(page.items.find((item) => item.id === id)?.placementAgenturKey).toBe(
      "beispielstadt-sued",
    );
  });
});
