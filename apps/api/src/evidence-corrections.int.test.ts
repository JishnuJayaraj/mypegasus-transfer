import { createDb, seedProjectIds, seedStaffUserIds } from "@transfer/db";
import {
  acceptDsvScan,
  auditContext,
  call,
  changeStatus,
  createWave,
  externalDsvOffer,
  informedParticipation,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "@transfer/db/testing";
import {
  AsuView,
  DocumentList,
  ParticipationDetail,
  ReviewQueue,
  Worklist,
} from "@transfer/domain";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbGuardFacts } from "./participations/guard-facts";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// Evidence corrections (data-protection.md, evidence corrections; D29, Q183, Q186, Q190,
// Q207 (6); readings Q209) against transfer_test: the PL's request on a document, an ASU
// registration and a closed BA outcome in ADR-0010's order, the decision from "Freigaben" (four
// eyes, no corrected value shown), what an approval does to the views, the work list and the
// facts, and the stale confirmation dialog of a superseded task. Synthetic data only.
const { app, db, logs } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord } = seedProjectIds;
const {
  projectLead,
  consultant,
  backOffice,
  regionalOperationsManager: manager,
} = seedStaffUserIds;
const staff = {} as Record<string, { Cookie: string }>;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const source = "Vermerk der PL vom 03.11., Az. intern 12";

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice, manager]) {
    staff[id] = await login(app, id);
  }
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  logs.length = 0;
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

function request(method: string, path: string, as: string, body?: unknown) {
  const init = method === "GET" ? { headers: staff[as]! } : jsonRequest(method, body, staff[as]!);
  return app.request(`/api/v1${path}`, init);
}
const sql = (text: string, params: unknown[] = []) => owner.$client.query(text, params);
const day = async (offset = 0) =>
  (await sql("select (berlin_today() + $1::int)::text as d", [offset])).rows[0].d as string;

/** An informed Werk Nord participation, assigned to the consultant unless `assign` is false. */
async function participation(assign = true) {
  const id = await call(owner.$client, "create_participation", {
    projectId: werkNord,
    context: pl,
  });
  await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(owner.$client, id, { field: "status", from: "contacted", to: "informed" });
  if (assign) {
    await call(owner.$client, "assign_participations", {
      projectId: werkNord,
      participationIds: [id],
      staffUserId: consultant,
      context: pl,
    });
  }
  return id;
}

/** An accepted BA confirmation added and reviewed by the consultant; its id. */
async function acceptedProof(id: string) {
  const documentId = await call(owner.$client, "add_document", {
    context: asConsultant,
    participationId: id,
    id: randomUUID(),
    type: "asu_proof",
    mediaType: "application/pdf",
    sizeBytes: 2048,
    contentSha256: createHash("sha256").update(randomUUID()).digest("hex"),
    fileName: null,
    keyId: randomBytes(8).toString("hex"),
    wrappedKey: randomBytes(60),
  });
  await call(owner.$client, "review_document", {
    context: asConsultant,
    documentId,
    decision: "accepted",
    reason: null,
  });
  return documentId;
}

/** A BA reporting task closed `not_required` by the PL; its id. */
async function closedTask(id: string) {
  const taskId = randomUUID();
  await sql(
    `insert into ba_reporting_task (id, participation_id, project_id, reporting_kind, subject_date,
       created_at)
     values ($1, $2, $3, 'planned_end_changed', berlin_today() + 30, now() - interval '3 days')`,
    [taskId, id, werkNord],
  );
  const res = await request("POST", `/ba-reporting-tasks/${taskId}/outcome`, projectLead, {
    outcome: "not_required",
    reason: "created_in_error",
  });
  expect(res.status).toBe(204);
  return taskId;
}

const requestCorrection = (id: string, body: object, as: string = projectLead) =>
  request("POST", `/participations/${id}/evidence-corrections`, as, {
    reason: "documented_internal_error",
    source,
    ...body,
  });
const requested = async (id: string, body: object) => {
  const res = await requestCorrection(id, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { correctionId: string }).correctionId;
};
const decide = (correctionId: string, decision: string, as: string = manager) =>
  request("POST", `/evidence-corrections/${correctionId}/decision`, as, { decision });
const reviews = async (as: string = manager) =>
  readJson(await request("GET", "/reviews", as), ReviewQueue);
const tasks = async (id: string) =>
  (await readJson(await request("GET", `/participations/${id}`, projectLead), ParticipationDetail))
    .baReportingTasks!;
const row = async (id: string) =>
  (
    await readJson(await request("GET", `/projects/${werkNord}/worklist`, projectLead), Worklist)
  ).items.find((item) => item.id === id)!;
const codes = async (res: Response) =>
  (await expectProblem(res, 422, "domain-error")).errors?.map((e) => e.code);

const kinds = async (id: string) => (await row(id)).caseItems.map((item) => item.kind);
const asuTab = async (id: string) =>
  readJson(await request("GET", `/participations/${id}/asu`, projectLead), AsuView);

/** Sets the route and records a registration: attested by the PL, or bare by the consultant. */
async function registered(id: string, registeredOn: string, attest: boolean) {
  const { route } = await asuTab(id);
  if (route.channel === null || route.channel === "kug_200b") {
    const set = await request("PUT", `/participations/${id}/asu/route`, projectLead, {
      channel: attest ? "online_self" : "in_person",
      version: route.version,
    });
    if (set.status !== 200) throw new Error(`route not set: ${set.status}`);
  }
  const res = await request(
    "POST",
    `/participations/${id}/asu/registration`,
    attest ? projectLead : consultant,
    {
      routeVersion: (await asuTab(id)).route.version,
      registeredOn,
      ...(attest && {
        attestation: { customerNumber: "123A456789", source: "ba_online_account_inspected" },
      }),
    },
  );
  expect(res.status).toBe(200);
  return (await asuTab(id)).registration!.id;
}
const attested = (id: string, registeredOn: string) => registered(id, registeredOn, true);

describe("POST /participations/{id}/evidence-corrections (D29)", () => {
  it("answers 404 for what the viewer can't see, 403 without the authority, 422 for the state", async () => {
    const id = await participation();
    const taskId = await closedTask(id);
    const body = { correction: "supersede_ba_report", taskId };
    // Hidden: an unassigned consultant, an unknown task, another participation's task.
    const other = await participation(false);
    await expectProblem(await requestCorrection(other, body, consultant), 404, "not-found");
    await expectProblem(
      await requestCorrection(id, { ...body, taskId: randomUUID() }),
      404,
      "not-found",
    );
    await expectProblem(await requestCorrection(other, body), 404, "not-found");
    // Back office reads the tasks but requests no correction of them; nor does the consultant.
    await expectProblem(await requestCorrection(id, body, backOffice), 403, "forbidden");
    await expectProblem(await requestCorrection(id, body, consultant), 403, "forbidden");
    // No default: the source and reason are required, the source one line.
    await expectProblem(
      await request("POST", `/participations/${id}/evidence-corrections`, projectLead, body),
      400,
      "validation-error",
    );
    await expectProblem(
      await requestCorrection(id, { ...body, source: "Zeile 1\nZeile 2" }),
      400,
      "validation-error",
    );
    await requested(id, body);
    expect(await codes(await requestCorrection(id, body))).toEqual(["correction_pending"]);
    // A pending task's outcome isn't corrected: it is recorded.
    const pending = randomUUID();
    await sql(
      `insert into ba_reporting_task (id, participation_id, project_id, reporting_kind, subject_date)
       values ($1, $2, $3, 'early_exit', berlin_today())`,
      [pending, id, werkNord],
    );
    expect(
      await codes(
        await requestCorrection(id, { correction: "supersede_ba_report", taskId: pending }),
      ),
    ).toEqual(["task_pending"]);
    // Logs carry codes, never the source.
    expect(JSON.stringify(logs)).not.toContain("Vermerk");
  });
});

describe("a BA outcome superseded (Q190, Q207 (6))", () => {
  it("shows in Freigaben without a value, is decided once by another person, and refuses the stale dialog", async () => {
    const id = await participation();
    const taskId = await closedTask(id);
    const [before] = await tasks(id);
    expect(before).toMatchObject({
      status: "not_required",
      supersededBy: null,
      correction: { pending: false, mayRequest: true },
    });
    const correctionId = await requested(id, { correction: "supersede_ba_report", taskId });
    expect((await tasks(id))[0]!.correction).toEqual({ pending: true, mayRequest: false });
    expect((await reviews()).corrections).toEqual([
      {
        correctionId,
        projectId: werkNord,
        projectName: expect.any(String),
        targetKind: "ba_reporting_task",
        action: "supersede",
        documentType: null,
        reportingKind: "planned_end_changed",
        wrongPerson: null,
        fieldKey: null,
        signatureKind: null,
        reason: "documented_internal_error",
        source,
        requestedOn: await day(),
        targetRecordedOn: await day(),
        capabilities: { decide: true },
      },
    ]);
    // The PL requested it: not theirs to decide; the consultant doesn't see it at all.
    await expectProblem(await decide(correctionId, "approve", projectLead), 403, "forbidden");
    await expectProblem(await decide(correctionId, "approve", consultant), 404, "not-found");
    expect((await decide(correctionId, "approve")).status).toBe(204);
    await expectProblem(await decide(correctionId, "reject"), 409, "conflict");
    const after = await tasks(id);
    const replacement = after.find((task) => task.replacesTaskId === taskId)!;
    expect(after.find((task) => task.id === taskId)).toMatchObject({
      status: "not_required",
      notRequiredReason: "created_in_error",
      supersededBy: replacement.id,
      correction: { pending: false, mayRequest: false },
      capabilities: { recordOutcome: false },
    });
    expect(replacement).toMatchObject({
      status: "pending",
      capabilities: { recordOutcome: true },
    });
    // A dialog opened for the original before the correction records nothing.
    expect(
      await codes(
        await request("POST", `/ba-reporting-tasks/${taskId}/outcome`, projectLead, {
          outcome: "reported",
          reportedOn: await day(),
        }),
      ),
    ).toEqual(["already_recorded"]);
    expect((await row(id)).agenturItems).toEqual([
      { kind: "ba_report_pending", date: await day() },
    ]);
    expect((await reviews()).corrections).toEqual([]);
  });

  it("changes nothing when rejected", async () => {
    const id = await participation();
    const taskId = await closedTask(id);
    const correctionId = await requested(id, { correction: "supersede_ba_report", taskId });
    expect((await decide(correctionId, "reject")).status).toBe(204);
    expect((await tasks(id)).map((task) => [task.id, task.status, task.supersededBy])).toEqual([
      [taskId, "not_required", null],
    ]);
  });
});

describe("a document invalidated (Q183)", () => {
  it("opens for nobody, counts nothing, flags the work list and keeps the status", async () => {
    const id = await participation();
    const documentId = await acceptedProof(id);
    const list = async () =>
      readJson(await request("GET", `/participations/${id}/documents`, consultant), DocumentList);
    const correctionId = await requested(id, {
      correction: "invalidate_document",
      documentId,
      wrongPerson: false,
    });
    expect((await list()).documents[0]).toMatchObject({
      correction: { invalidated: false, pending: true },
      capabilities: { open: true, requestCorrection: false },
    });
    expect((await decide(correctionId, "approve")).status).toBe(204);
    expect((await list()).documents[0]).toMatchObject({
      id: documentId,
      correction: { invalidated: true, pending: false },
      capabilities: { open: false, quarantine: false, requestCorrection: false },
    });
    expect(
      await codes(
        await request(
          "POST",
          `/participations/${id}/documents/${documentId}/opening`,
          consultant,
          {},
        ),
      ),
    ).toEqual(["document_invalidated"]);
    const item = await row(id);
    expect(item.status).toBe("informed");
    expect(item.caseItems).toContainEqual({ kind: "evidence_invalidated", date: await day() });
    // An accepted replacement that proves no registration doesn't resolve it (the review of
    // PR #103); a registration resting on proof does.
    await acceptedProof(id);
    expect((await row(id)).caseItems.map((i) => i.kind)).toContain("evidence_invalidated");
    await attested(id, await day(-3));
    expect((await row(id)).caseItems.map((i) => i.kind)).not.toContain("evidence_invalidated");
  });

  it("purges a wrong person's file: the tombstone and the history stay", async () => {
    const id = await participation();
    const documentId = await acceptedProof(id);
    const correctionId = await requested(id, {
      correction: "invalidate_document",
      documentId,
      wrongPerson: true,
    });
    expect((await decide(correctionId, "approve")).status).toBe(204);
    const { rows } = await sql(
      `select deleted_at is not null as deleted, delete_reason::text, invalidated_by_correction
       from document where id = $1`,
      [documentId],
    );
    expect(rows).toEqual([
      { deleted: true, delete_reason: "wrong_person", invalidated_by_correction: correctionId },
    ]);
    const { rows: events } = await sql(
      `select event_type::text as type from audit_event
       where participation_id = $1 and event_type::text like 'evidence_correction%' order by seq`,
      [id],
    );
    expect(events.map((e) => e.type)).toEqual([
      "evidence_correction_requested",
      "evidence_correction_decided",
    ]);
  });
});

describe("an ASU registration superseded (Q186)", () => {
  it("records the corrected date at the approval instant; the fact rests on the new registration", async () => {
    const id = await participation();
    await request("PUT", `/participations/${id}/asu/route`, projectLead, {
      channel: "online_self",
      version: 0,
    });
    const tab = async () =>
      readJson(await request("GET", `/participations/${id}/asu`, projectLead), AsuView);
    const res = await request("POST", `/participations/${id}/asu/registration`, projectLead, {
      routeVersion: (await tab()).route.version,
      registeredOn: await day(-10),
      attestation: { customerNumber: "123A456789", source: "ba_online_account_inspected" },
    });
    expect(res.status).toBe(200);
    const original = (await tab()).registration!;
    expect(original).toMatchObject({
      corrected: false,
      correction: { pending: false, mayRequest: true },
    });
    // The consultant reads the registration but requests no correction.
    await expectProblem(
      await requestCorrection(
        id,
        {
          correction: "supersede_asu_registration",
          registrationId: original.id,
          registeredOn: await day(-12),
        },
        consultant,
      ),
      403,
      "forbidden",
    );
    const correctionId = await requested(id, {
      correction: "supersede_asu_registration",
      registrationId: original.id,
      registeredOn: await day(-12),
    });
    expect((await reviews()).corrections[0]).not.toHaveProperty("registeredOn");
    expect((await decide(correctionId, "approve")).status).toBe(204);
    const { rows } = await sql(
      "select to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as at from evidence_correction where id = $1",
      [correctionId],
    );
    const current = (await tab()).registration!;
    expect(current).toMatchObject({
      registeredOn: await day(-12),
      corrected: true,
      withProofSince: rows[0].at,
      correction: { pending: false, mayRequest: true },
    });
    expect(current.id).not.toBe(original.id);
    const facts = await db.transaction((tx) =>
      dbGuardFacts.facts(tx, { participationId: id, currentRequest: null }),
    );
    expect(facts.asuRegisteredWithProof).toEqual({
      validOn: await day(-12),
      recordedAt: new Date(rows[0].at),
    });
    // The old registration is history: it can't be corrected again.
    expect(
      await codes(
        await requestCorrection(id, {
          correction: "invalidate_asu_registration",
          registrationId: original.id,
        }),
      ),
    ).toEqual(["target_corrected"]);
  });
});

describe("Nachweis ungültig until the evidence is replaced (Q209 (7), the review of PR #103)", () => {
  it("stays after an invalidated registration until a new one rests on a linked proof", async () => {
    const id = await participation();
    const registrationId = await attested(id, await day(-10));
    await decide(
      await requested(id, { correction: "invalidate_asu_registration", registrationId }),
      "approve",
    );
    expect(await kinds(id)).toContain("evidence_invalidated");
    // A new registration without its proof gives no fact.
    const again = await registered(id, await day(-2), false);
    expect(await kinds(id)).toContain("evidence_invalidated");
    // An accepted BA confirmation that isn't linked yet supports nothing.
    const proof = await acceptedProof(id);
    expect(await kinds(id)).toContain("evidence_invalidated");
    const linked = await request("POST", `/participations/${id}/asu/proof-link`, consultant, {
      registrationId: again,
      documentId: proof,
    });
    expect(linked.status).toBe(200);
    expect(await kinds(id)).not.toContain("evidence_invalidated");
  });

  it("stays after an invalidated TL 407 until one signed by the retained profilingDoneOn is accepted", async () => {
    const id = await participation();
    for (const [from, to] of [
      ["not_started", "profiling_accepted"],
      ["profiling_accepted", "profiling_in_progress"],
    ] as const) {
      await changeStatus(owner.$client, id, { field: "profiling_status", from, to });
    }
    const signedOn = await day(-5);
    const scan = async (signed: string) => {
      const res = await request("POST", `/participations/${id}/documents`, consultant, {
        type: "tl407_signed_scan",
        fileName: "scan.pdf",
        content: Buffer.from(
          `%PDF-1.7\n1 0 obj\n<< /Title (synthetic scan ${randomUUID()}) >>\nendobj\n%%EOF\n`,
        ).toString("base64"),
        origin: "external_paper",
      });
      expect(res.status).toBe(201);
      const { id: documentId } = (await res.json()) as { id: string };
      const reviewed = await request(
        "POST",
        `/participations/${id}/documents/${documentId}/review`,
        consultant,
        {
          decision: "accepted",
          scan: {
            participantSignedOn: signed,
            profilerSignedOn: signed,
            confirmations: ["signatures_present", "all_pages_present"],
            formVersion: "08-2025",
            declarations: { kind: "as_marked", jobboerseChoice: "full", baContactConsent: true },
          },
        },
      );
      expect(reviewed.status).toBe(200);
      return documentId;
    };
    const first = await scan(signedOn);
    const profilingView = (await (
      await request("GET", `/participations/${id}/profiling`, consultant)
    ).json()) as { statusVersion: number };
    const done = await request("POST", `/participations/${id}/profiling-status`, consultant, {
      to: "profiling_done",
      effectiveDate: signedOn,
      statusVersion: profilingView.statusVersion,
    });
    expect(done.status).toBe(200);
    await decide(
      await requested(id, {
        correction: "invalidate_document",
        documentId: first,
        wrongPerson: false,
      }),
      "approve",
    );
    expect(await kinds(id)).toContain("evidence_invalidated");
    // Signed after the retained completion: it can't support it.
    await scan(await day(-1));
    expect(await kinds(id)).toContain("evidence_invalidated");
    await scan(signedOn);
    expect(await kinds(id)).not.toContain("evidence_invalidated");
    // The status stayed as it was throughout.
    expect((await row(id)).profilingStatus).toBe("profiling_done");
  });
});

/** An informed participation in a wave whose offer is signed by a packet scan; the scan's id. */
async function signedPacket() {
  const wave = await createWave(owner.$client);
  const id = await informedParticipation(owner.$client, {
    projectId: werkNord,
    entryWaveId: wave,
  });
  await externalDsvOffer(owner.$client, id);
  const signed = await day(-4);
  const all = { participant: signed, customer: signed, transfergesellschaft: signed };
  const scan = await acceptDsvScan(owner.$client, id, all);
  await call(owner.$client, "sign_dsv", {
    context: pl,
    participationId: id,
    scanId: scan,
    statusVersion: (await sql("select status_version from participation where id=$1", [id])).rows[0]
      .status_version,
  });
  return { id, scan, signed, all };
}
const invalidate = async (id: string, scan: string) =>
  decide(
    await requested(id, {
      correction: "invalidate_document",
      documentId: scan,
      wrongPerson: false,
    }),
    "approve",
  );

describe("Nachweis ungültig for a DSV scan (process-and-lifecycle.md, DSV packet; D8)", () => {
  it("stays until a counting scan of the same offer, accepted after the approval, shows the same dates", async () => {
    const { id, scan, signed, all } = await signedPacket();
    expect(await kinds(id)).not.toContain("evidence_invalidated");
    await invalidate(id, scan);
    expect((await sql("select count(*)::int as n from dsv_facts($1)", [[id]])).rows[0].n).toBe(0);
    expect(await kinds(id)).toContain("evidence_invalidated");
    // A countersigned original missing the TG's signature supports less than the invalidated one.
    await acceptDsvScan(owner.$client, id, { participant: signed, customer: signed });
    expect(await kinds(id)).toContain("evidence_invalidated");
    // A different participant date is refused while the invalidated scan keeps its recorded date.
    await expect(
      acceptDsvScan(owner.$client, id, { ...all, participant: await day(-3) }),
    ).rejects.toMatchObject({ message: "signature_date_mismatch" });
    await acceptDsvScan(owner.$client, id, all);
    expect(await kinds(id)).not.toContain("evidence_invalidated");
    // The status stays; nothing restores an invalidation or repairs the entry.
    expect(
      (await sql("select dsv_status from participation where id=$1", [id])).rows[0].dsv_status,
    ).toBe("dsv_signed");
  });
});
