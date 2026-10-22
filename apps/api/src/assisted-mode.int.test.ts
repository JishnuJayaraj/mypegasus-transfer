import {
  and,
  assistedMode,
  auditEvent,
  createDb,
  eq,
  inArray,
  participantAssignment,
  participantIdentity,
  participation,
  seedProjectIds,
  seedStaffUserIds,
} from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import {
  AssistedModeView,
  AssistedSelfService,
  AssistedSelfServiceWrite,
  ParticipationDetail,
  ParticipationSelfService,
  ParticipationSensitiveValues,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// Assisted mode and the staff view of self-service data (ADR-0007, assisted mode;
// data-protection.md, self-service; Q136) against transfer_test. Synthetic values only.
const { app, db, logs } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const projectId = seedProjectIds.verwaltung;
const NOTICE = "self-service-purposes:v1";
type Who = "projectLead" | "consultant" | "backOffice" | "regionalAdmin";
const staff = {} as Record<Who, { Cookie: string }>;
/** Every response body of the test, to check where a value leaves. */
const answered: { path: string; body: string }[] = [];

const RV = "65170839J003";
const baDetails = {
  pensionInsuranceNumber: RV,
  nationality: { kind: "other", country: "PL" },
  entryToGermanyDate: "2015-09-05",
  residenceStatus: "settlement_permit",
  buergergeld: false,
};
/** Values that must leave only through the sensitive GETs. */
const secrets = [RV, "settlement_permit", "2015-09-05", '"PL"'];

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const user of ["projectLead", "consultant", "backOffice", "regionalAdmin"] as const) {
    staff[user] = await login(app, seedStaffUserIds[user]);
  }
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  logs.length = 0;
  answered.length = 0;
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

/** A participation without an account (ADR-0007: some never activate). */
async function person() {
  const id = randomUUID();
  await owner.insert(participation).values({
    id,
    projectId,
    status: "imported",
    profilingStatus: "not_started",
    dsvStatus: "not_offered",
  });
  await owner.insert(participantIdentity).values({
    participationId: id,
    projectId,
    personnelNumber: `SYN-${id.slice(-8)}`,
    firstName: "Erika",
    lastName: "Beispiel",
    birthDate: "1970-01-01",
  });
  return id;
}

const assign = (participationId: string) =>
  owner.insert(participantAssignment).values({
    projectId,
    participationId,
    staffUserId: seedStaffUserIds.consultant,
    assignedBy: seedStaffUserIds.projectLead,
  });

async function send(cookie: { Cookie: string }, method: string, path: string, body?: unknown) {
  const init = method === "GET" ? { headers: cookie } : jsonRequest(method, body ?? {}, cookie);
  const res = await app.request(`/api/v1${path}`, init);
  answered.push({ path, body: await res.clone().text() });
  return res;
}

const start = (who: { Cookie: string }, participationId: string, how = "phone") =>
  send(who, "POST", `/participations/${participationId}/assisted-mode`, { confirmed: true, how });

/** Opens assisted mode and acknowledges the notice the participant was shown. */
async function opened(who: { Cookie: string }, participationId: string) {
  const { assistedModeId } = await readJson(await start(who, participationId), AssistedModeView);
  const base = `/participations/${participationId}/assisted/self-service`;
  const q = `?assistedModeId=${assistedModeId}`;
  const res = await send(who, "POST", `${base}/notice${q}`, { version: NOTICE, language: "de" });
  expect(res.status).toBe(204);
  return {
    assistedModeId,
    get: (path = "") => send(who, "GET", `${base}${path}${q}`),
    put: (path: string, body: unknown) => send(who, "PUT", `${base}${path}${q}`, body),
    state: async () => readJson(await send(who, "GET", `${base}${q}`), AssistedSelfService),
  };
}

const audited = (participationId: string, types: string[]) =>
  owner
    .select({
      type: auditEvent.eventType,
      actor: auditEvent.actorType,
      staffUserId: auditEvent.actorStaffUserId,
      onBehalfOf: auditEvent.onBehalfOfParticipationId,
      details: auditEvent.details,
    })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.participationId, participationId),
        inArray(auditEvent.eventType, types as never),
      ),
    )
    .orderBy(auditEvent.seq);

const codes = async (res: Response, status: number, type: string) =>
  (await expectProblem(res, status, type)).errors?.map(({ code }) => code);

describe("POST and DELETE /participations/{id}/assisted-mode (Q136)", () => {
  it("needs the confirmation and how; opens it without an account, audited", async () => {
    const id = await person();
    for (const body of [
      { confirmed: false, how: "phone" },
      { confirmed: true },
      { confirmed: true, how: "video" },
      { confirmed: true, how: "phone", note: "asked for help" },
    ]) {
      const res = await send(
        staff.projectLead,
        "POST",
        `/participations/${id}/assisted-mode`,
        body,
      );
      await expectProblem(res, 400, "validation-error");
    }
    const res = await start(staff.projectLead, id, "in_person");
    expect(res.status).toBe(201);
    const mode = await readJson(res, AssistedModeView);
    expect(mode).toMatchObject({ participationId: id, how: "in_person" });
    expect(await audited(id, ["assisted_mode_started"])).toEqual([
      {
        type: "assisted_mode_started",
        actor: "user",
        staffUserId: seedStaffUserIds.projectLead,
        onBehalfOf: null,
        details: { assistedModeId: mode.assistedModeId, how: "in_person" },
      },
    ]);
    const detail = await readJson(
      await send(staff.projectLead, "GET", `/participations/${id}`),
      ParticipationDetail,
    );
    expect(detail.capabilities.startAssistedMode).toBe(true);
  });

  it("lets the PL, back office and the assigned consultant open it, nobody else", async () => {
    const id = await person();
    expect((await start(staff.backOffice, id)).status).toBe(201);
    await expectProblem(await start(staff.consultant, id), 403, "forbidden");
    await assign(id);
    expect((await start(staff.consultant, id)).status).toBe(201);
    await expectProblem(await start(staff.regionalAdmin, id), 403, "forbidden");
  });

  it("refuses a terminal participation", async () => {
    const id = await person();
    await owner
      .update(participation)
      .set({
        status: "withdrawn",
        endReason: "other",
        endReasonSource: "user",
        withdrawnOn: "2026-10-21",
      })
      .where(eq(participation.id, id));
    expect(await codes(await start(staff.projectLead, id), 422, "domain-error")).toEqual([
      "participation_closed",
    ]);
  });

  it("ends on 'Beenden' and with the staff session", async () => {
    const id = await person();
    const lead = await login(app, seedStaffUserIds.projectLead);
    const mode = await opened(lead, id);
    expect((await send(lead, "DELETE", `/participations/${id}/assisted-mode`)).status).toBe(204);
    expect(await codes(await mode.get(), 403, "forbidden")).toEqual(["assisted_mode_required"]);
    const again = await opened(lead, id);
    expect((await send(lead, "POST", "/auth/logout")).status).toBe(204);
    const [row] = await owner
      .select({ endReason: assistedMode.endReason })
      .from(assistedMode)
      .where(eq(assistedMode.id, again.assistedModeId));
    expect(row).toEqual({ endReason: "staff_session_ended" });
    const relogged = await login(app, seedStaffUserIds.projectLead);
    const res = await send(
      relogged,
      "GET",
      `/participations/${id}/assisted/self-service?assistedModeId=${again.assistedModeId}`,
    );
    expect(await codes(res, 403, "forbidden")).toEqual(["assisted_mode_required"]);
  });
});

describe("the assisted routes (Q136)", () => {
  it("need a live mode of this staff session and participation", async () => {
    const id = await person();
    const base = `/participations/${id}/assisted/self-service`;
    await expectProblem(await send(staff.projectLead, "GET", base), 400, "validation-error");
    const unknown = `?assistedModeId=${randomUUID()}`;
    expect(
      await codes(await send(staff.projectLead, "GET", `${base}${unknown}`), 403, "forbidden"),
    ).toEqual(["assisted_mode_required"]);
    const mode = await opened(staff.backOffice, id);
    // Back office's mode isn't the PL's, nor another participation's.
    const theirs = `?assistedModeId=${mode.assistedModeId}`;
    expect(
      await codes(await send(staff.projectLead, "GET", `${base}${theirs}`), 403, "forbidden"),
    ).toEqual(["assisted_mode_required"]);
    const other = await person();
    const elsewhere = `/participations/${other}/assisted/self-service${theirs}`;
    expect(await codes(await send(staff.backOffice, "GET", elsewhere), 403, "forbidden")).toEqual([
      "assisted_mode_required",
    ]);
  });

  it("show the PL confidential and health/disability, never the BA details", async () => {
    const id = await person();
    const mode = await opened(staff.projectLead, id);
    const state = await mode.state();
    expect(state.pages.map((p) => p.page)).not.toContain("ba_details");
    expect(state.pages.find((p) => p.page === "health")!.fields.map((f) => f.key)).toEqual([
      "healthRestrictions",
      "severeDisability",
    ]);
    expect(Object.keys(state.sensitive)).toEqual(["healthRestrictions", "severeDisability"]);
    expect(state.missing.map((m) => m.key)).not.toContain("pensionInsuranceNumber");
    await expectProblem(await mode.get("/sensitive/ba_details"), 403, "forbidden");
    await expectProblem(
      await mode.put("/sensitive/ba_details", { revision: 0, values: baDetails }),
      403,
      "forbidden",
    );
    const saved = await mode.put("/sensitive/health", {
      revision: 0,
      values: { healthRestrictions: false, severeDisability: true },
    });
    await expect(readJson(saved, AssistedSelfServiceWrite)).resolves.toMatchObject({
      revision: 1,
      sensitive: { healthRestrictions: true, severeDisability: true },
    });
    const read = await readJson(await mode.get("/sensitive/health"), ParticipationSensitiveValues);
    expect(read.values).toEqual({ healthRestrictions: false, severeDisability: true });
  });

  it("show back office all but health; a hidden field is an unknown one", async () => {
    const id = await person();
    const mode = await opened(staff.backOffice, id);
    const state = await mode.state();
    expect(state.pages.find((p) => p.page === "health")!.fields.map((f) => f.key)).toEqual([
      "severeDisability",
    ]);
    expect(state.pages.map((p) => p.page)).toContain("ba_details");
    expect(state.sensitive).not.toHaveProperty("healthRestrictions");
    const hidden = await mode.put("/sensitive/health", {
      revision: 0,
      values: { healthRestrictions: true, severeDisability: true },
    });
    expect(await codes(hidden, 422, "domain-error")).toEqual(["unknown_field"]);
    expect(
      (await mode.put("/sensitive/health", { revision: 0, values: { severeDisability: true } }))
        .status,
    ).toBe(200);
    expect(
      (await mode.put("/sensitive/ba_details", { revision: 1, values: baDetails })).status,
    ).toBe(200);
    const read = await readJson(await mode.get("/sensitive/health"), ParticipationSensitiveValues);
    expect(read.values).toEqual({ severeDisability: true });
  });

  it("show the assigned consultant every field", async () => {
    const id = await person();
    await assign(id);
    const mode = await opened(staff.consultant, id);
    const state = await mode.state();
    expect(state.pages.flatMap((p) => p.fields.map((f) => f.key))).toEqual(
      expect.arrayContaining(["pensionInsuranceNumber", "healthRestrictions", "gender"]),
    );
    expect(
      (await mode.put("/sensitive/ba_details", { revision: 0, values: baDetails })).status,
    ).toBe(200);
    const read = await readJson(
      await mode.get("/sensitive/ba_details"),
      ParticipationSensitiveValues,
    );
    expect(read.values).toEqual(baDetails);
  });

  it("audit writes as actor and onBehalfOf; contact fields become participant-maintained", async () => {
    const id = await person();
    const mode = await opened(staff.projectLead, id);
    const contact = {
      address: { street: "Musterweg 2", postalCode: "10115", city: "Berlin", country: "DE" },
      mobile: "+4915100000000",
    };
    const res = await mode.put("/pages/contact", { revision: 0, values: contact });
    expect(res.status).toBe(200);
    expect(
      await mode.put("/pages/contact", { revision: 0, values: contact }).then((r) => r.status),
    ).toBe(409);
    const changed = await audited(id, [
      "participant_data_changed",
      "self_service_notice_acknowledged",
    ]);
    expect(changed.map((e) => [e.type, e.actor, e.staffUserId, e.onBehalfOf])).toEqual([
      ["self_service_notice_acknowledged", "user", seedStaffUserIds.projectLead, id],
      ["participant_data_changed", "user", seedStaffUserIds.projectLead, id],
    ]);
    const view = await readJson(
      await send(staff.projectLead, "GET", `/participations/${id}/self-service`),
      ParticipationSelfService,
    );
    expect(view.participantMaintained).toEqual(["address", "mobile"]);
  });

  it("leave no value in logs, errors or audit details", async () => {
    const id = await person();
    await assign(id);
    const mode = await opened(staff.consultant, id);
    await mode.put("/sensitive/ba_details", { revision: 0, values: baDetails });
    await mode.put("/sensitive/ba_details", {
      revision: 0,
      values: { ...baDetails, residenceStatus: "nonsense" },
    });
    await mode.get("/sensitive/ba_details");
    const writes = await audited(id, ["sensitive_write", "sensitive_read"]);
    expect(writes.every((e) => e.onBehalfOf === id && e.actor === "user")).toBe(true);
    const trail = JSON.stringify(
      await owner.select().from(auditEvent).where(eq(auditEvent.participationId, id)),
    );
    const elsewhere = answered.filter(
      ({ path, body }) => !/\/sensitive\/ba_details\?/.test(path) || body.includes('"type"'),
    );
    for (const value of secrets) {
      expect(logs.join("\n")).not.toContain(value);
      expect(trail).not.toContain(value);
      expect(elsewhere.filter(({ body }) => body.includes(value)).map(({ path }) => path)).toEqual(
        [],
      );
    }
  });
});

describe("the staff view in normal mode (the 'Selbstauskunft' tab)", () => {
  async function filled() {
    const id = await person();
    await assign(id);
    const mode = await opened(staff.consultant, id);
    await mode.put("/sensitive/ba_details", { revision: 0, values: baDetails });
    await mode.put("/sensitive/health", {
      revision: 1,
      values: { healthRestrictions: true, severeDisability: null },
    });
    return id;
  }
  const view = async (who: { Cookie: string }, id: string) =>
    readJson(
      await send(who, "GET", `/participations/${id}/self-service`),
      ParticipationSelfService,
    );

  it("shows presence per role and which fields each may read, never a value", async () => {
    const id = await filled();
    const consultant = await view(staff.consultant, id);
    expect(consultant.sensitive).toMatchObject({
      pensionInsuranceNumber: true,
      severeDisability: false,
    });
    expect(consultant.sensitiveReadable).toHaveLength(7);
    const backOffice = await view(staff.backOffice, id);
    expect(backOffice.sensitive).not.toHaveProperty("healthRestrictions");
    expect(backOffice.sensitiveReadable).not.toContain("healthRestrictions");
    const lead = await view(staff.projectLead, id);
    expect(lead.sensitive).toEqual({ healthRestrictions: true, severeDisability: false });
    expect(lead.sensitiveReadable).toEqual([]);
    for (const body of answered.filter(({ path }) => path.endsWith("/self-service"))) {
      for (const value of secrets) expect(body.body).not.toContain(value);
    }
  });

  it("reads one field on 'Anzeigen', audited", async () => {
    const id = await filled();
    const res = await send(
      staff.backOffice,
      "GET",
      `/participations/${id}/self-service/sensitive/ba_details?field=pensionInsuranceNumber`,
    );
    expect((await readJson(res, ParticipationSensitiveValues)).values).toEqual({
      pensionInsuranceNumber: RV,
    });
    const reads = await audited(id, ["sensitive_read"]);
    expect(reads.at(-1)).toMatchObject({
      staffUserId: seedStaffUserIds.backOffice,
      onBehalfOf: null,
      details: { key: "pensionInsuranceNumber" },
    });
    const wrong = await send(
      staff.backOffice,
      "GET",
      `/participations/${id}/self-service/sensitive/health?field=pensionInsuranceNumber`,
    );
    await expectProblem(wrong, 400, "validation-error");
    const hidden = await send(
      staff.backOffice,
      "GET",
      `/participations/${id}/self-service/sensitive/health?field=healthRestrictions`,
    );
    await expectProblem(hidden, 403, "forbidden");
  });
});
