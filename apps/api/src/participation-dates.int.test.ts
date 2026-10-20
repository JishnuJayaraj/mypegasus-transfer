import { SystemClock } from "@transfer/adapters";
import { eq, participantIdentity, participation, seedWaves } from "@transfer/db";
import { ParticipationDetail } from "@transfer/domain";
import { describe, expect, it } from "vitest";
import { app, auth, fixture, importFile, owner } from "./imports/import-testing";
import { expectProblem, jsonRequest, readJson } from "./testing";

// Slice 2 plan 5.7 (PR 2h-3; rounds 32–34; AC-37, AC-47, AC-48): the PL changes the contractual
// TG dates; a signed DSV needs its amendment; each changed date leaves a pending BA task.

const [w1] = seedWaves;
const today = new SystemClock().today();
const detail = (id: string, user = "projectLead") =>
  app.request(`/api/v1/participations/${id}`, { headers: auth[user] });
const put = (id: string, body: object, user = "projectLead") =>
  app.request(`/api/v1/participations/${id}/dates`, jsonRequest("PUT", body, auth[user]));
const errorsOf = async (res: Response) =>
  (await expectProblem(res, 422, "domain-error")).errors?.map(({ pointer, code }) => [
    pointer,
    code,
  ]);

/** BSP-0001 of the sample file, assigned to W1 (01.03.2091–29.02.2092, latest entry 15.03.2091). */
async function inWave() {
  expect((await importFile(fixture("teilnehmer-beispiel.csv"))).status).toBe(200);
  const [row] = await owner
    .select({ id: participantIdentity.participationId })
    .from(participantIdentity)
    .where(eq(participantIdentity.personnelNumber, "BSP-0001"));
  const id = row!.id;
  const assigned = await app.request(
    `/api/v1/participations/${id}/entry-wave`,
    jsonRequest("PUT", { waveId: w1.id }, auth.projectLead),
  );
  return { id, version: (await readJson(assigned, ParticipationDetail)).statusVersion };
}

/** The same participation informed with a signed DSV (set as owner: the project is a draft). */
async function signed(tgEnd: string | null = null) {
  const { id } = await inWave();
  await owner
    .update(participation)
    .set({ status: "informed", dsvStatus: "dsv_signed", tgEnd })
    .where(eq(participation.id, id));
  return { id, version: (await readJson(await detail(id), ParticipationDetail)).statusVersion };
}

const amendment = {
  fullyExecutedOn: today,
  originalLocation: "paper_personnel_file",
  documentReference: "DSV-2026/0001",
  originalInspected: true,
  allPartiesSigned: true,
  retrievable: true,
};

describe("PUT /api/v1/participations/{participationId}/dates (AC-37, AC-48)", () => {
  it("lets the PL change the end before signature and shows its pending BA task", async () => {
    const { id, version } = await inWave();
    const before = await readJson(await detail(id), ParticipationDetail);
    expect(before.capabilities.setParticipationDates).toBe(true);
    const res = await put(id, { tgStart: null, tgEnd: "2092-01-31", expectedVersion: version });
    const body = await readJson(res, ParticipationDetail);
    expect(body.statusVersion).toBe(version + 1);
    expect(body.dates).toMatchObject({ tgEnd: "2092-01-31", effectiveTgEnd: "2092-01-31" });
    expect(body.amendments).toEqual([]);
    expect(body.baReportingTasks).toEqual([
      expect.objectContaining({
        reportingKind: "planned_end_changed",
        subjectDate: "2092-01-31",
        status: "pending",
        reportedOn: null,
      }),
    ]);
  });

  it("refuses with every rule at its field, and a stale version with 409", async () => {
    const { id, version } = await inWave();
    // The former employment ends 31.12.2026 (the sample file): a gap before 05.03.2091.
    expect(
      await errorsOf(
        await put(id, { tgStart: "2091-03-05", tgEnd: "2092-03-05", expectedVersion: version }),
      ),
    ).toEqual([
      ["/tgStart", "ba_review_required"],
      ["/tgEnd", "period_exceeds_twelve_months"],
    ]);
    const stale = await expectProblem(
      await put(id, { tgStart: null, tgEnd: "2092-01-31", expectedVersion: version + 5 }),
      409,
      "conflict",
    );
    expect(stale.errors?.map((e) => e.code)).toEqual(["stale_status"]);
    expect(
      await errorsOf(await put(id, { tgStart: null, tgEnd: null, expectedVersion: version })),
    ).toEqual([["", "dates_unchanged"]]);
  });

  it("needs the amendment once the DSV is signed, and records it with its task", async () => {
    const { id, version } = await signed("2092-01-31");
    expect(
      await errorsOf(
        await put(id, { tgStart: null, tgEnd: "2092-02-29", expectedVersion: version }),
      ),
    ).toEqual([["/amendment", "dsv_amendment_required"]]);
    expect(
      await errorsOf(
        await put(id, {
          tgStart: null,
          tgEnd: "2092-01-15",
          expectedVersion: version,
          amendment,
        }),
      ),
    ).toEqual([["/tgEnd", "end_not_extension"]]);
    expect(
      await errorsOf(
        await put(id, {
          tgStart: null,
          tgEnd: "2092-02-29",
          expectedVersion: version,
          amendment: { ...amendment, allPartiesSigned: false },
        }),
      ),
    ).toEqual([["/amendment", "amendment_unconfirmed"]]);
    const body = await readJson(
      await put(id, { tgStart: null, tgEnd: "2092-02-29", expectedVersion: version, amendment }),
      ParticipationDetail,
    );
    expect(body.amendments).toEqual([
      expect.objectContaining({
        kind: "extension",
        fullyExecutedOn: today,
        oldTgEnd: "2092-01-31",
        newTgEnd: "2092-02-29",
        originalLocation: "paper_personnel_file",
        documentReference: "DSV-2026/0001",
      }),
    ]);
    expect(body.baReportingTasks).toEqual([
      expect.objectContaining({ reportingKind: "planned_end_changed", subjectDate: "2092-02-29" }),
    ]);
  });

  it("is the PL's: back office sees the tasks but may not change dates", async () => {
    const { id, version } = await inWave();
    await put(id, { tgStart: null, tgEnd: "2092-01-31", expectedVersion: version });
    const shown = await readJson(await detail(id, "backOffice"), ParticipationDetail);
    expect(shown.capabilities.setParticipationDates).toBe(false);
    expect(shown.refusals.setParticipationDates).toBe("forbidden");
    expect(shown.baReportingTasks).toHaveLength(1);
    await expectProblem(
      await put(
        id,
        { tgStart: null, tgEnd: "2092-01-15", expectedVersion: version + 1 },
        "backOffice",
      ),
      403,
      "forbidden",
    );
    await expectProblem(
      await put(crypto.randomUUID(), { tgStart: null, tgEnd: null, expectedVersion: 0 }),
      404,
      "not-found",
    );
  });

  it("says why the dates can't change while a DSV offer is open", async () => {
    const { id } = await inWave();
    await owner
      .update(participation)
      .set({ status: "informed", dsvStatus: "dsv_offered" })
      .where(eq(participation.id, id));
    const shown = await readJson(await detail(id), ParticipationDetail);
    expect(shown.refusals.setParticipationDates).toBe("dsv_offer_open");
  });
});
