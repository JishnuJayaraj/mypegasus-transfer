import { auditEvent, eq, participation, participantIdentity, seedWaves } from "@transfer/db";
import { ParticipationDetail } from "@transfer/domain";
import { describe, expect, it } from "vitest";
import { app, auth, codes, fixture, importFile, owner, werkNord } from "./imports/import-testing";
import { expectProblem, jsonRequest, readJson } from "./testing";

// Slice 2 plan, "Planned in PR 2h" (PR 2h-1; R29–R31, R33; AC-34, AC-38, AC-50): the detail of
// one participation per viewer, and the PL's wave assignment.

const [w1, w2] = seedWaves;
const detail = (id: string, user = "projectLead") =>
  app.request(`/api/v1/participations/${id}`, { headers: auth[user] });
const assign = (id: string, waveId: string, user = "projectLead") =>
  app.request(
    `/api/v1/participations/${id}/entry-wave`,
    jsonRequest("PUT", { waveId }, auth[user]),
  );

/** Imports the sample file into Werk Nord and returns the id of `BSP-0001`. */
async function imported() {
  expect((await importFile(fixture("teilnehmer-beispiel.csv"))).status).toBe(200);
  const [row] = await owner
    .select({ id: participantIdentity.participationId })
    .from(participantIdentity)
    .where(eq(participantIdentity.personnelNumber, "BSP-0001"));
  return row!.id;
}

describe("GET /api/v1/participations/{participationId} (AC-34)", () => {
  it("shows the PL the case data, the person fields and the wave choice", async () => {
    const id = await imported();
    const body = await readJson(await detail(id), ParticipationDetail);
    expect(body).toMatchObject({
      id,
      projectId: werkNord,
      status: "imported",
      profilingStatus: "not_started",
      dsvStatus: "not_offered",
      entryWave: null,
      dates: { tgStart: null, tgEnd: null, effectiveTgStart: null, effectiveTgEnd: null },
      hints: [],
      capabilities: { assignEntryWave: true },
    });
    expect(body.person).toMatchObject({
      personnelNumber: "BSP-0001",
      lastName: "Mustermann",
      firstName: "Erika",
      address: { postalCode: "99999", city: "Beispielstadt", country: "DE" },
    });
    expect(Object.keys(body.person).toSorted()).toEqual(
      [
        "address",
        "birthDate",
        "firstName",
        "lastName",
        "mobile",
        "oldEmploymentEndDate",
        "personnelNumber",
        "phone",
        "privateEmail",
        "workEmail",
      ].toSorted(),
    );
  });

  it("shows back office the same data without the wave choice", async () => {
    const id = await imported();
    const body = await readJson(await detail(id, "backOffice"), ParticipationDetail);
    expect(body.person.personnelNumber).toBe("BSP-0001");
    expect(body.capabilities).toEqual({ assignEntryWave: false });
  });

  it("refuses the consultant without assignments and the org roles (403)", async () => {
    const id = await imported();
    for (const user of ["consultant", "admin", "regionalOperationsManager"]) {
      await expectProblem(await detail(id, user), 403, "forbidden");
    }
  });

  it("is a 404 for an unknown id and a 400 for a malformed one", async () => {
    await expectProblem(await detail(crypto.randomUUID()), 404, "not-found");
    await expectProblem(await detail("x"), 400, "validation-error");
  });
});

describe("PUT /api/v1/participations/{participationId}/entry-wave (AC-38, AC-50)", () => {
  it("assigns a wave and returns the participation with the wave's dates", async () => {
    const id = await imported();
    const body = await readJson(await assign(id, w1.id), ParticipationDetail);
    expect(body.entryWave).toMatchObject({ id: w1.id, code: "W1", name: w1.name });
    expect(body.dates).toMatchObject({
      effectiveTgStart: w1.defaultTgStart,
      effectiveTgEnd: w1.defaultTgEnd,
    });
    const events = await owner
      .select({ type: auditEvent.eventType })
      .from(auditEvent)
      .where(eq(auditEvent.participationId, id));
    expect(events.map((e) => e.type)).toContain("entry_wave_assigned");
    // Another wave may follow while no DSV is offered; the same one again is unchanged.
    expect((await assign(id, w2.id)).status).toBe(200);
    expect(await codes(await assign(id, w2.id))).toEqual(["wave_unchanged"]);
  });

  it("refuses back office, an unknown wave and a hidden participation", async () => {
    const id = await imported();
    await expectProblem(await assign(id, w1.id, "backOffice"), 403, "forbidden");
    expect(await codes(await assign(id, crypto.randomUUID()))).toEqual(["wave_of_other_project"]);
    await expectProblem(await assign(crypto.randomUUID(), w1.id), 404, "not-found");
    await expectProblem(await assign(id, w1.id, "admin"), 403, "forbidden");
  });

  it("keeps the wave of a participation with individual dates (R33)", async () => {
    const id = await imported();
    await assign(id, w1.id);
    await owner.update(participation).set({ tgEnd: "2092-01-31" }).where(eq(participation.id, id));
    const body = await readJson(await detail(id), ParticipationDetail);
    expect(body.capabilities.assignEntryWave).toBe(false);
    expect(await codes(await assign(id, w2.id))).toEqual(["individual_dates_set"]);
  });
});
