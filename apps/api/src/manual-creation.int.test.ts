import { loadBaseDefaults } from "@transfer/config/load";
import {
  auditEvent,
  eq,
  importColumnMapping,
  participantIdentity,
  participation,
  seedWaves,
} from "@transfer/db";
import { ImportPreview, ImportResult, ParticipationDetail } from "@transfer/domain";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  app,
  auth,
  b64,
  confirm,
  counts,
  fixture,
  importFile,
  noDecisions,
  owner,
  previewOf,
  verwaltung,
  werkNord,
} from "./imports/import-testing";
import { Slots } from "./imports/slots";
import { expectProblem, jsonRequest, readJson, testApp } from "./testing";

// Version 2 adds the TL 407 rules (regional-variation.md, base defaults).
const baseDefaultsVersion = loadBaseDefaults().version;

// Manual creation through the import's rules, the parse-worker cap and the header-row guard of
// saved mappings (process-and-lifecycle.md, Import; ADR-0010, uploads; round 33).

const [w1] = seedWaves;
const create = (body: object, user = "projectLead", projectId: string = werkNord) =>
  app.request(
    `/api/v1/projects/${projectId}/participations`,
    jsonRequest("POST", body, auth[user]),
  );
const person = {
  personnelNumber: "BSP-0100",
  lastName: "Beispiel",
  firstName: "Bernd",
  birthDate: "01.01.1970",
  oldEmploymentEndDate: "31.12.2026",
  addressStreet: "Musterstraße 100",
  addressPostalCode: "99999",
  addressCity: "Beispielstadt",
  mobile: "0171 3920099",
};
const errorsOf = async (res: Response) =>
  (await expectProblem(res, 422, "domain-error")).errors?.map(({ pointer, code }) => [
    pointer,
    code,
  ]);
const eventsOf = async (participationId: string) =>
  (
    await owner
      .select({
        type: auditEvent.eventType,
        reason: auditEvent.reasonCode,
        details: auditEvent.details,
      })
      .from(auditEvent)
      .where(eq(auditEvent.participationId, participationId))
      .orderBy(auditEvent.seq)
  ).map(({ type, reason, details }) => ({ type, reason, details }));

describe("POST /api/v1/projects/{projectId}/participations (R32, AC-51)", () => {
  it("creates one person with the wave and returns the participation", async () => {
    const res = await create({ values: person, waveId: w1.id });
    expect(res.status).toBe(201);
    const body = await readJson(res, ParticipationDetail);
    expect(body).toMatchObject({
      projectId: werkNord,
      status: "imported",
      entryWave: { id: w1.id },
      person: {
        personnelNumber: "BSP-0100",
        birthDate: "1970-01-01",
        address: {
          street: "Musterstraße 100",
          postalCode: "99999",
          city: "Beispielstadt",
          country: "DE",
        },
        phone: null,
      },
    });
    expect(await eventsOf(body.id)).toEqual([
      expect.objectContaining({ type: "participation_created" }),
      expect.objectContaining({ type: "participant_data_changed" }),
      { type: "participation_created_manually", reason: null, details: { baseDefaultsVersion } },
    ]);
  });

  it("refuses what the import refuses, at the fields, and writes nothing", async () => {
    const before = await counts();
    expect(await errorsOf(await create({ values: { personnelNumber: "BSP-0100" } }))).toEqual([
      ["/values/lastName", "required_missing"],
      ["/values/firstName", "required_missing"],
      ["/values/birthDate", "required_missing"],
      ["/values/oldEmploymentEndDate", "required_missing"],
      ["/values/address", "required_missing"],
    ]);
    expect(
      await errorsOf(await create({ values: { ...person, phone: "12", addressCity: "" } })),
    ).toEqual([
      ["/values/address", "address_incomplete"],
      ["/values/phone", "value_invalid"],
    ]);
    expect(await counts()).toEqual(before);
  });

  it("refuses an existing Personalnummer and names that participation", async () => {
    await importFile(fixture("teilnehmer-beispiel.csv"));
    const [existing] = await owner
      .select({ id: participantIdentity.participationId })
      .from(participantIdentity)
      .where(eq(participantIdentity.personnelNumber, "BSP-0001"));
    const problem = await expectProblem(
      await create({ values: { ...person, personnelNumber: "BSP-0001" } }),
      422,
      "domain-error",
    );
    expect(problem.errors?.map((e) => e.code)).toEqual(["personnel_number_taken"]);
    expect(problem.participationId).toBe(existing!.id);
  });

  it("needs the warnings confirmed, and audits them", async () => {
    const young = { ...person, birthDate: "01.01.2015" };
    expect(await errorsOf(await create({ values: young }))).toEqual([
      ["", "warnings_unconfirmed"],
      ["/values/birthDate", "age_implausible"],
    ]);
    const body = await readJson(
      await create({ values: young, confirmWarnings: true }),
      ParticipationDetail,
    );
    expect(await eventsOf(body.id)).toContainEqual({
      type: "warning_confirmed",
      reason: "age_implausible",
      details: {},
    });
  });

  it("needs a decision for a possible duplicate, and audits creating it anyway", async () => {
    await importFile(fixture("teilnehmer-beispiel.csv"));
    const twin = { ...person, lastName: "Mustermann", firstName: "Erika", birthDate: "01.01.1965" };
    expect(await errorsOf(await create({ values: twin }))).toEqual([["", "possible_duplicate"]]);
    const body = await readJson(
      await create({ values: twin, createDespiteDuplicate: true }),
      ParticipationDetail,
    );
    expect(await eventsOf(body.id)).toContainEqual({
      type: "warning_confirmed",
      reason: "possible_duplicate",
      details: {},
    });
  });

  it("creates one of two concurrent requests for the same Personalnummer", async () => {
    const results = await Promise.all([create({ values: person }), create({ values: person })]);
    expect(results.map((r) => r.status).toSorted()).toEqual([201, 422]);
    const rows = await owner
      .select()
      .from(participantIdentity)
      .where(eq(participantIdentity.personnelNumber, "BSP-0100"));
    expect(rows).toHaveLength(1);
  });

  it("is the PL's: back office and org roles 403, an invisible project 404, a foreign wave 422", async () => {
    await expectProblem(await create({ values: person }, "backOffice"), 403, "forbidden");
    await expectProblem(await create({ values: person }, "admin"), 403, "forbidden");
    await expectProblem(
      await create({ values: person }, "projectLead", crypto.randomUUID()),
      404,
      "not-found",
    );
    expect(await errorsOf(await create({ values: person, waveId: crypto.randomUUID() }))).toEqual([
      ["/waveId", "wave_of_other_project"],
    ]);
    expect(
      await errorsOf(await create({ values: person, waveId: w1.id }, "projectLead", verwaltung)),
    ).toEqual([["/waveId", "not_ta_tg"]]);
    await expectProblem(
      await create({ values: { ...person, addressCountry: "DE" } }),
      400,
      "validation-error",
    );
    expect(await owner.select().from(participation)).toHaveLength(0);
  });
});

/** A 503 `import_busy` with `Retry-After` (R43). */
const expectBusy = async (res: Response) => {
  const problem = await expectProblem(res, 503, "service-unavailable");
  expect(res.headers.get("retry-after")).toBe("10");
  expect(problem.errors?.map((e) => e.code)).toEqual(["import_busy"]);
};

describe("the parse-worker cap (R43, AC-52)", () => {
  // A test app with its own slots: one worker, one waiting request, a 300 ms wait.
  const slots = new Slots({ running: 1, waiting: 1, waitMs: 300 });
  const busy = testApp({ importSlots: slots });
  afterAll(() => busy.db.$client.end());
  const csv = fixture("teilnehmer-beispiel.csv");
  const previewBusy = () =>
    busy.app.request(
      `/api/v1/projects/${werkNord}/imports/preview`,
      jsonRequest("POST", { file: csv }, auth.projectLead),
    );
  const confirmBusy = () =>
    busy.app.request(
      `/api/v1/projects/${werkNord}/imports`,
      jsonRequest(
        "POST",
        {
          file: csv,
          mapping: [{ column: 0, target: "personnelNumber" }],
          decisions: noDecisions,
          previewToken: "0".repeat(64),
        },
        auth.projectLead,
      ),
    );

  it("lets a waiting request through once the worker is free", async () => {
    const release = await slots.acquire();
    const pending = previewBusy();
    await vi.waitFor(() => expect(slots.stats()).toEqual({ running: 1, waiting: 1 }));
    release();
    expect((await pending).status).toBe(200);
    expect(slots.stats()).toEqual({ running: 0, waiting: 0 });
  });

  it("answers 503 import_busy with Retry-After when the wait expires, on preview and confirm", async () => {
    const release = await slots.acquire();
    try {
      await expectBusy(await previewBusy());
      await expectBusy(await confirmBusy());
    } finally {
      release();
    }
    expect(slots.stats()).toEqual({ running: 0, waiting: 0 });
  });

  it("answers 503 at once when the queue is full", async () => {
    const release = await slots.acquire();
    const waiter = slots.acquire().catch((error: unknown) => error);
    try {
      const started = Date.now();
      await expectBusy(await previewBusy());
      expect(Date.now() - started).toBeLessThan(300);
    } finally {
      release();
      await waiter;
    }
  });
});

describe("the header-row guard of saved mappings (R44, AC-53)", () => {
  const file = b64(
    [
      "Teilnehmerliste;;;;;;;;",
      "BSP-0001;Mustermann;Erika;01.01.1965;31.12.2026;Musterstraße 1;99999;Beispielstadt;Deutschland",
      "BSP-0002;Musterfrau;Max;03.02.1967;31.12.2026;Musterstraße 2;99999;Beispielstadt;Deutschland",
    ].join("\n"),
  );
  const targets = [
    "personnelNumber",
    "lastName",
    "firstName",
    "birthDate",
    "oldEmploymentEndDate",
    "addressStreet",
    "addressPostalCode",
    "addressCity",
    "addressCountry",
  ] as const;
  const mapping = targets.map((target, column) => ({ column, target }));

  it("imports below a data-like header row but saves no mapping, and the preview says so", async () => {
    const shown = await previewOf(werkNord, { file, headerRow: 2, mapping });
    expect(shown.headerLooksLikeData).toBe(true);
    const result = await readJson(
      await confirm(werkNord, {
        file,
        headerRow: 2,
        mapping,
        decisions: noDecisions,
        previewToken: shown.previewToken,
      }),
      ImportResult,
    );
    expect(result).toMatchObject({ created: 1, mappingSaved: false });
    expect(await owner.select().from(importColumnMapping)).toHaveLength(0);
  });

  it("says so when no header could be saved because every mapped one is blank or punctuation", async () => {
    const blank = b64(
      [
        "-;--;;...;/;();+;*;#",
        "BSP-0001;Mustermann;Erika;01.01.1965;31.12.2026;Musterstraße 1;99999;Beispielstadt;Deutschland",
      ].join("\n"),
    );
    const shown = await previewOf(werkNord, { file: blank, mapping });
    expect(shown.headerLooksLikeData).toBe(false);
    const result = await readJson(
      await confirm(werkNord, {
        file: blank,
        mapping,
        decisions: noDecisions,
        previewToken: shown.previewToken,
      }),
      ImportResult,
    );
    expect(result).toMatchObject({ created: 1, mappingSaved: false });
    expect(await owner.select().from(importColumnMapping)).toHaveLength(0);
  });

  it("saves the mapping of a real header row", async () => {
    const shown = await readJson(
      await app.request(
        `/api/v1/projects/${werkNord}/imports/preview`,
        jsonRequest("POST", { file: fixture("teilnehmer-beispiel.csv") }, auth.projectLead),
      ),
      ImportPreview,
    );
    expect(shown.headerLooksLikeData).toBe(false);
    const res = await importFile(fixture("teilnehmer-beispiel.csv"));
    expect(await readJson(res, ImportResult)).toMatchObject({ created: 12, mappingSaved: true });
    expect((await owner.select().from(importColumnMapping)).length).toBeGreaterThan(0);
  });
});
