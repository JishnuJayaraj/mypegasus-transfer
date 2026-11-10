import { createDb, seedProjectIds, seedRegionIds, seedStaffUserIds, seedWaves } from "@transfer/db";
import {
  acceptDsvScan,
  call,
  changeStatus,
  externalDsvOffer,
  informedParticipation,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "@transfer/db/testing";
import {
  ParticipationDetail,
  ReconciliationReviewItem,
  ReviewQueue,
  TgEntryReconciliationState,
  Worklist,
} from "@transfer/domain";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

// The reconciliation of a missed TG entry and its review (process-and-lifecycle.md, the
// reconciliation; Q68 case 2, Q80, Q216) against transfer_test: the PL's dialog and write in
// ADR-0010's order, the manager's review in "Freigaben" without a participant id or name, the PL's
// reply and "Rückfrage zum Eintritt" on the work list until resolved. Synthetic values only.
const { app, db, logs } = testApp();
const owner = createDb(testDatabaseUrls().owner);
const { werkNord } = seedProjectIds;
const {
  projectLead,
  consultant,
  backOffice,
  regionalOperationsManager: manager,
} = seedStaffUserIds;
const w1 = seedWaves.find((wave) => wave.code === "W1")!;
const staff = {} as Record<string, { Cookie: string }>;
const sources = { request: "Vermerk Akte 12 vom 3.4.", reply: "Scan-Datum laut Eingangsbuch 7" };

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

const request = (method: string, path: string, as: string, body?: unknown) =>
  app.request(
    `/api/v1${path}`,
    method === "GET" ? { headers: staff[as]! } : jsonRequest(method, body, staff[as]!),
  );
const sql = (text: string, params: unknown[] = []) => owner.$client.query(text, params);
const day = async (offset = 0) =>
  (await sql("select (berlin_today() + $1::int)::text as d", [offset])).rows[0].d as string;

/**
 * An informed participation of W1 whose planned start was `startOffset` days from today, with
 * every entry fact: the ASU registration attested ten days ago, the TL 407 signed ten days ago with
 * profiling done on it, and the complete DSV packet signed five days ago (`signedOffset`).
 */
async function missedEntry(
  options: { startOffset?: number; tl407Offset?: number; signedOffset?: number } = {},
) {
  const { startOffset = -1, tl407Offset = -10, signedOffset = -5 } = options;
  const id = await informedParticipation(owner.$client, {
    projectId: werkNord,
    entryWaveId: w1.id,
  });
  await call(owner.$client, "assign_participations", {
    projectId: werkNord,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  // The ASU registration with its attestation (process-and-lifecycle.md, Arbeitsuchendmeldung).
  const asu = await request("GET", `/participations/${id}/asu`, projectLead);
  const route = ((await asu.json()) as { route: { version: number } }).route;
  expect(
    (
      await request("PUT", `/participations/${id}/asu/route`, projectLead, {
        channel: "online_self",
        version: route.version,
      })
    ).status,
  ).toBe(200);
  const routed = (await (
    await request("GET", `/participations/${id}/asu`, projectLead)
  ).json()) as {
    route: { version: number };
  };
  const registered = await request("POST", `/participations/${id}/asu/registration`, projectLead, {
    routeVersion: routed.route.version,
    registeredOn: await day(-10),
    attestation: { customerNumber: "123A456789", source: "ba_online_account_inspected" },
  });
  expect(registered.status).toBe(200);
  // The signed TL 407 and profiling done on its date.
  for (const [from, to] of [
    ["not_started", "profiling_accepted"],
    ["profiling_accepted", "profiling_in_progress"],
  ] as const) {
    await changeStatus(owner.$client, id, { field: "profiling_status", from, to });
  }
  const signed = await day(tl407Offset);
  const upload = await request("POST", `/participations/${id}/documents`, consultant, {
    type: "tl407_signed_scan",
    fileName: "scan.pdf",
    content: Buffer.from(
      `%PDF-1.7\n1 0 obj\n<< /Title (synthetic scan ${randomUUID()}) >>\nendobj\n%%EOF\n`,
    ).toString("base64"),
    origin: "external_paper",
  });
  expect(upload.status).toBe(201);
  const { id: scan } = (await upload.json()) as { id: string };
  const reviewed = await request(
    "POST",
    `/participations/${id}/documents/${scan}/review`,
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
  const profiling = (await (
    await request("GET", `/participations/${id}/profiling`, consultant)
  ).json()) as { statusVersion: number };
  const done = await request("POST", `/participations/${id}/profiling-status`, consultant, {
    to: "profiling_done",
    effectiveDate: signed,
    statusVersion: profiling.statusVersion,
  });
  expect(done.status).toBe(200);
  // The complete DSV packet, then "Als unterschrieben erfassen".
  await externalDsvOffer(owner.$client, id);
  const on = await day(signedOffset);
  const packet = await acceptDsvScan(owner.$client, id, {
    participant: on,
    customer: on,
    transfergesellschaft: on,
  });
  await call(owner.$client, "sign_dsv", {
    context: pl,
    participationId: id,
    scanId: packet,
    statusVersion: (await sql("select status_version from participation where id=$1", [id])).rows[0]
      .status_version,
  });
  await sql(
    "update participation set offer_deadline = berlin_today() - 20, tg_start = berlin_today() + $2::int where id = $1",
    [id, startOffset],
  );
  return { id, packet };
}

const state = async (id: string, as: string = projectLead) => {
  const res = await request("GET", `/participations/${id}/tg-entry-reconciliation`, as);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return readJson(res, TgEntryReconciliationState);
};
const body = (s: TgEntryReconciliationState, over: Record<string, unknown> = {}) => ({
  evidence: s.evidence.map(({ kind, id, validOn }) => ({ kind, id, validOn })),
  statusVersion: s.statusVersion,
  confirmed: true,
  ...over,
});
const reconcile = async (
  id: string,
  over: Record<string, unknown> = {},
  as: string = projectLead,
) =>
  request("POST", `/participations/${id}/tg-entry-reconciliation`, as, body(await state(id), over));
const queue = async (as: string = manager) =>
  readJson(await request("GET", "/reviews", as), ReviewQueue);
const review = async (
  reconciliationId: string,
  payload: Record<string, unknown>,
  as: string = manager,
) =>
  request("POST", `/reconciliations/${reconciliationId}/review`, as, {
    revision: (await queue()).reconciliations.find((r) => r.id === reconciliationId)?.revision ?? 0,
    ...payload,
  });
const reply = async (id: string, reconciliationId: string, as: string = projectLead) =>
  request("POST", `/reconciliations/${reconciliationId}/reply`, as, {
    code: "explained",
    source: sources.reply,
    revision: (await state(id)).reconciliation!.revision,
  });
const caseItems = async (id: string) =>
  (
    await readJson(await request("GET", `/projects/${werkNord}/worklist`, projectLead), Worklist)
  ).items
    .find((item) => item.id === id)!
    .caseItems.map((item) => item.kind);
const errors = async (res: Response, status: number) => {
  expect(res.status).toBe(status);
  return ((await res.json()) as { errors: { pointer: string; code: string }[] }).errors.map(
    ({ pointer, code }) => `${pointer}:${code}`,
  );
};

describe("GET and POST /participations/{id}/tg-entry-reconciliation", () => {
  it("lists the evidence with its actual days and enters with the TG start as the effective date", async () => {
    const { id, packet } = await missedEntry();
    const read = await state(id);
    expect(read).toMatchObject({
      tgStart: await day(-1),
      problems: [],
      reconciliation: null,
      capabilities: { reconcile: true, reply: false },
      refusal: null,
    });
    expect(read.evidence.map((e) => [e.kind, e.validOn])).toEqual([
      ["dsv_packet", await day(-5)],
      ["asu_registration", await day(-10)],
      ["tl407", await day(-10)],
    ]);
    expect(read.evidence[0]!.id).toBe(packet);
    // Back office reads the tab, may not reconcile.
    expect((await state(id, backOffice)).capabilities.reconcile).toBe(false);
    const res = await reconcile(id);
    expect(res.status).toBe(201);
    const json = await readJson(res, TgEntryReconciliationState);
    expect(json.reconciliation).toMatchObject({
      effectiveDate: await day(-1),
      reconciledOn: await day(0),
      stage: "requested",
      revision: 0,
      steps: [],
    });
    expect(json.capabilities.reconcile).toBe(false);
    const detail = await readJson(
      await request("GET", `/participations/${id}`, projectLead),
      ParticipationDetail,
    );
    expect(detail).toMatchObject({
      status: "active_in_tg",
      dates: { tgEntryDate: await day(-1) },
    });
    // Logs carry ids and codes only.
    const text = logs.join("\n");
    expect(text).toContain("tg entry reconciliation");
    expect(text).not.toMatch(/Arslan|Beispiel|123A456789/);
  });

  it("answers 404 before 403 before 409 and 422", async () => {
    const { id } = await missedEntry();
    const s = await state(id);
    await expectProblem(
      await request(
        "POST",
        `/participations/${randomUUID()}/tg-entry-reconciliation`,
        projectLead,
        body(s),
      ),
      404,
      "not-found",
    );
    // The assigned consultant sees the participation, not the DSV: 403; back office may not.
    await expectProblem(
      await request("POST", `/participations/${id}/tg-entry-reconciliation`, consultant, body(s)),
      403,
      "forbidden",
    );
    await expectProblem(
      await request("POST", `/participations/${id}/tg-entry-reconciliation`, backOffice, body(s)),
      403,
      "forbidden",
    );
    // A stale status version, then evidence that differs from what was listed: 409 with pointers.
    expect(
      await errors(
        await request(
          "POST",
          `/participations/${id}/tg-entry-reconciliation`,
          projectLead,
          body(s, { statusVersion: s.statusVersion - 1 }),
        ),
        409,
      ),
    ).toEqual(["/statusVersion:stale_status"]);
    const changed = body(s, {
      evidence: s.evidence.map((e) => ({
        kind: e.kind,
        id: e.kind === "dsv_packet" ? randomUUID() : e.id,
        validOn: e.validOn,
      })),
    });
    expect(
      await errors(
        await request(
          "POST",
          `/participations/${id}/tg-entry-reconciliation`,
          projectLead,
          changed,
        ),
        409,
      ),
    ).toEqual(["/evidence:source_changed"]);
    // No confirmation: refused by the schema, never preset.
    await expectProblem(
      await request(
        "POST",
        `/participations/${id}/tg-entry-reconciliation`,
        projectLead,
        body(s, { confirmed: false }),
      ),
      400,
      "validation-error",
    );
    expect((await sql("select status from participation where id=$1", [id])).rows[0].status).toBe(
      "informed",
    );
  });

  it("refuses before the TG start and on it until that day's run completed", async () => {
    const { id } = await missedEntry({ startOffset: 1 });
    expect((await state(id)).refusal).toBe("before_tg_start");
    expect(await errors(await reconcile(id), 422)).toEqual([":tg_start_date"]);
    await sql("update participation set tg_start = berlin_today() where id=$1", [id]);
    expect((await state(id)).refusal).toBe("run_not_completed");
    expect(await errors(await reconcile(id), 422)).toEqual([":tg_start_date"]);
    await sql(
      `insert into job_run (job_name, run_date, scheduled_at, completed_at)
       values ('lifecycle.sweep', berlin_today(),
         (berlin_today()::timestamp + interval '1 minute') at time zone 'Europe/Berlin',
         (berlin_today()::timestamp + interval '6 minutes') at time zone 'Europe/Berlin')`,
    );
    expect((await state(id)).refusal).toBeNull();
    expect((await reconcile(id)).status).toBe(201);
  });

  it("refuses evidence valid only after the TG start: never backdated", async () => {
    // The TL 407 was signed yesterday, the planned start was three days ago.
    const { id } = await missedEntry({ startOffset: -3, tl407Offset: -1 });
    const read = await state(id);
    expect(read.refusal).toBe("evidence_incomplete");
    expect(read.problems).toEqual([{ fact: "profiling", code: "evidence_after_tg_start" }]);
    // Listed with its actual day; named anyway, it is refused by its guard.
    expect(read.evidence.map((e) => [e.kind, e.validOn])).toContainEqual(["tl407", await day(-1)]);
    const evidence = read.evidence.map(({ kind, id: ref, validOn }) => ({
      kind,
      id: ref,
      validOn,
    }));
    const res = await request(
      "POST",
      `/participations/${id}/tg-entry-reconciliation`,
      projectLead,
      {
        evidence,
        statusVersion: read.statusVersion,
        confirmed: true,
      },
    );
    expect(await errors(res, 422)).toEqual([":profiling_done_or_approved_exception"]);
  });
});

async function reconciled() {
  const missed = await missedEntry();
  expect((await reconcile(missed.id)).status).toBe(201);
  const reconciliationId = (await state(missed.id)).reconciliation!.id;
  return { ...missed, reconciliationId };
}

describe("the review in Freigaben, the reply and the resolution", () => {
  it("lists it without a participant id or name, by schema", async () => {
    const { id, reconciliationId } = await reconciled();
    const res = await request("GET", "/reviews", manager);
    const text = await res.clone().text();
    const { reconciliations } = await readJson(res, ReviewQueue);
    expect(reconciliations).toHaveLength(1);
    expect(reconciliations[0]).toMatchObject({
      id: reconciliationId,
      projectId: werkNord,
      tgStart: await day(-1),
      stage: "requested",
      capabilities: { outcomes: ["no_objection", "clarification_requested"] },
    });
    expect(reconciliations[0]!.evidence.map((e) => e.kind)).toEqual([
      "dsv_packet",
      "asu_registration",
      "tl407",
    ]);
    expect(Object.keys(ReconciliationReviewItem.shape)).not.toEqual(
      expect.arrayContaining(["participationId"]),
    );
    expect(
      Object.keys(ReconciliationReviewItem.shape).filter((k) => /name|participant/i.test(k)),
    ).toEqual(["projectName"]);
    expect(text).not.toContain(id);
    // The PL has no queue.
    await expectProblem(await request("GET", "/reviews", projectLead), 403, "forbidden");
  });

  it("keeps the clarification on the PL's list through the reply until the manager resolves it", async () => {
    const { id, reconciliationId } = await reconciled();
    expect(await caseItems(id)).not.toContain("reconciliation_clarification");
    expect(
      (
        await review(reconciliationId, {
          outcome: "clarification_requested",
          code: "date_unclear",
          source: sources.request,
        })
      ).status,
    ).toBe(204);
    expect(await caseItems(id)).toContain("reconciliation_clarification");
    expect((await state(id)).capabilities.reply).toBe(true);
    expect((await state(id, backOffice)).capabilities.reply).toBe(false);
    // Only a PL replies.
    await expectProblem(await reply(id, reconciliationId, backOffice), 403, "forbidden");
    expect((await reply(id, reconciliationId)).status).toBe(204);
    expect(await caseItems(id)).toContain("reconciliation_clarification");
    const item = (await queue()).reconciliations[0]!;
    expect(item.stage).toBe("replied");
    expect(item.steps.map((s) => [s.kind, s.code, s.source])).toEqual([
      ["clarification_requested", "date_unclear", sources.request],
      ["replied", "explained", sources.reply],
    ]);
    expect(item.capabilities.outcomes).toEqual([
      "resolved_no_objection",
      "escalated_to_dpo",
      "clarification_requested",
    ]);
    expect(
      (
        await review(reconciliationId, {
          outcome: "resolved_no_objection",
          source: "Rücksprache PL, Vermerk 8",
        })
      ).status,
    ).toBe(204);
    expect(await caseItems(id)).not.toContain("reconciliation_clarification");
    expect((await queue()).reconciliations).toEqual([]);
    // The sources never reach a log.
    expect(logs.join("\n")).not.toMatch(/Vermerk|Eingangsbuch/);
  });

  it("keeps an escalation open in the queue and on the list until it is resolved", async () => {
    const { id, reconciliationId } = await reconciled();
    await review(reconciliationId, {
      outcome: "clarification_requested",
      code: "evidence_unclear",
      source: sources.request,
    });
    await reply(id, reconciliationId);
    expect(
      (
        await review(reconciliationId, {
          outcome: "escalated_to_dpo",
          source: "An DSB, Vorgang 4",
        })
      ).status,
    ).toBe(204);
    expect((await queue()).reconciliations[0]).toMatchObject({
      stage: "escalated_to_dpo",
      capabilities: { outcomes: ["resolved_no_objection"] },
    });
    expect(await caseItems(id)).toContain("reconciliation_clarification");
    expect(await errors(await review(reconciliationId, { outcome: "no_objection" }), 422)).toEqual([
      "/outcome:outcome_not_allowed",
    ]);
  });

  it("refuses the PL who reconciled, even holding the manager's role, and a stale revision", async () => {
    await sql(
      "insert into staff_org_role(staff_user_id, role, region_id) values ($1, 'regional_operations_manager', $2)",
      [projectLead, seedRegionIds.nord],
    );
    const { reconciliationId } = await reconciled();
    const own = (await queue(projectLead)).reconciliations[0]!;
    expect(own.capabilities.outcomes).toEqual([]);
    expect(
      await errors(await review(reconciliationId, { outcome: "no_objection" }, projectLead), 403),
    ).toEqual([":four_eyes"]);
    expect(
      await errors(
        await request("POST", `/reconciliations/${reconciliationId}/review`, manager, {
          outcome: "no_objection",
          revision: 3,
        }),
        409,
      ),
    ).toEqual(["/revision:stale_reconciliation"]);
    // Unknown: 404; another role in the project: 403.
    await expectProblem(
      await request("POST", `/reconciliations/${randomUUID()}/review`, manager, {
        outcome: "no_objection",
        revision: 0,
      }),
      404,
      "not-found",
    );
    await expectProblem(
      await review(reconciliationId, { outcome: "no_objection" }, backOffice),
      403,
      "forbidden",
    );
    expect((await review(reconciliationId, { outcome: "no_objection" })).status).toBe(204);
    expect(
      await errors(
        await request("POST", `/reconciliations/${reconciliationId}/review`, manager, {
          outcome: "no_objection",
          revision: 1,
        }),
        422,
      ),
    ).toEqual([":not_awaiting"]);
  });
});

// Date corrections (data-protection.md, evidence corrections: field targets and the DSV
// signature-date supersession) with the reconciliation: a corrected fact is recorded at its
// approval, so the scheduled run before it never counted it, and the reconciliation uses it.
const correction = (id: string, payload: object, as: string = projectLead) =>
  request("POST", `/participations/${id}/evidence-corrections`, as, {
    reason: "documented_internal_error",
    source: "Personalakte, TL 407 Seite 2",
    ...payload,
  });
const approve = (id: string, as: string = manager) =>
  request("POST", `/evidence-corrections/${id}/decision`, as, { decision: "approve" });
const correctionId = async (res: Response) => {
  expect(res.status).toBe(201);
  return ((await res.json()) as { correctionId: string }).correctionId;
};
const detail = async (id: string, as: string = projectLead) =>
  readJson(await request("GET", `/participations/${id}`, as), ParticipationDetail);

describe("date corrections and the missed entry", () => {
  it("reconciles a missed start with a corrected profilingDoneOn, changing no status or past event", async () => {
    const { id } = await missedEntry();
    // The completion was typed as today: after the TG start, so no entry fact held on it.
    await sql("update participation set profiling_done_on = berlin_today() where id = $1", [id]);
    expect((await state(id)).capabilities.reconcile).toBe(false);
    expect((await detail(id)).dateCorrections).toEqual({
      profilingDoneOn: { pending: false, mayRequest: true },
      withdrawnOn: null,
    });
    // Back office and the consultant see no such capability and are refused.
    expect((await detail(id, backOffice)).dateCorrections).toBeUndefined();
    await expectProblem(
      await correction(
        id,
        { correction: "correct_field", field: "profilingDoneOn", value: await day(-10) },
        backOffice,
      ),
      403,
      "forbidden",
    );
    // A date before the TL 407's signature: 422 with its pointer.
    expect(
      await errors(
        await correction(id, {
          correction: "correct_field",
          field: "profilingDoneOn",
          value: await day(-11),
        }),
        422,
      ),
    ).toEqual(["/value:effective_date_before_signature"]);
    const events = await sql(
      "select id from audit_event where participation_id = $1 order by seq",
      [id],
    );
    const pending = await correctionId(
      await correction(id, {
        correction: "correct_field",
        field: "profilingDoneOn",
        value: await day(-10),
      }),
    );
    expect((await detail(id)).dateCorrections!.profilingDoneOn).toEqual({
      pending: true,
      mayRequest: false,
    });
    // "Freigaben": the field key, never the value, the participant's id or name.
    const item = (await queue()).corrections.find((c) => c.correctionId === pending)!;
    expect(item).toMatchObject({
      targetKind: "field",
      action: "supersede",
      fieldKey: "profilingDoneOn",
      signatureKind: null,
      documentType: null,
    });
    expect(JSON.stringify(item)).not.toContain(await day(-10));
    expect(JSON.stringify(item)).not.toContain(id);
    expect((await approve(pending)).status).toBe(204);
    // A second decision is 409 source_changed (the queue showed another state).
    const again = await approve(pending);
    expect(await errors(again, 409)).toEqual([":source_changed"]);
    // The corrected fact holds on the TG start: the reconciliation passes.
    const read = await state(id);
    expect(read.evidence.find((e) => e.kind === "tl407")!.validOn).toBe(await day(-10));
    expect((await reconcile(id)).status).toBe(201);
    // Nothing past changed: every earlier event is still there, as recorded.
    const later = await sql(
      "select id from audit_event where participation_id = $1 order by seq limit $2",
      [id, events.rows.length],
    );
    expect(later.rows).toEqual(events.rows);
    // Logs carry ids and codes only: no date, no source.
    const text = logs.join("\n");
    expect(text).toContain("evidence correction requested");
    expect(text).not.toContain("Personalakte");
    expect(text).not.toContain(await day(-10));
  });

  it("supersedes a DSV signature date requested by back office; the entry loses its support until corrected again", async () => {
    const { id } = await missedEntry();
    expect((await reconcile(id)).status).toBe(201);
    const offer = (
      await sql("select id from dsv_offer where participation_id = $1 and ended_as = 'signed'", [
        id,
      ])
    ).rows[0].id as string;
    const supersede = (signedOn: string, as: string = backOffice) =>
      correction(
        id,
        {
          correction: "supersede_dsv_signature",
          offerId: offer,
          paper: "dsv_signed_scan",
          signature: "customer",
          signedOn,
        },
        as,
      );
    // Another participation's offer, or an offer the consultant can't read: 404.
    await expectProblem(
      await request("POST", `/participations/${id}/evidence-corrections`, backOffice, {
        correction: "supersede_dsv_signature",
        offerId: randomUUID(),
        paper: "dsv_signed_scan",
        signature: "customer",
        signedOn: await day(0),
        reason: "documented_internal_error",
        source: "Akte",
      }),
      404,
      "not-found",
    );
    await expectProblem(await supersede(await day(0), consultant), 404, "not-found");
    expect(await errors(await supersede(await day(1)), 422)).toEqual([
      "/signedOn:corrected_on_in_future",
    ]);
    // The countersignature was actually given today, after the TG start.
    const pending = await correctionId(await supersede(await day(0)));
    expect(await errors(await supersede(await day(-2)), 422)).toEqual([":correction_pending"]);
    const item = (await queue()).corrections.find((c) => c.correctionId === pending)!;
    expect(item).toMatchObject({
      targetKind: "dsv_signature",
      documentType: "dsv_signed_scan",
      signatureKind: "customer",
      fieldKey: null,
    });
    expect(await caseItems(id)).not.toContain("evidence_invalidated");
    expect((await approve(pending)).status).toBe(204);
    // The DSV tab shows the corrected date on the packet; the entry stays, "Nachweis ungültig".
    const dsv = (await (await request("GET", `/participations/${id}/dsv`, backOffice)).json()) as {
      scans: { metadata: { signatures: Record<string, string> } }[];
    };
    expect(dsv.scans.map((s) => s.metadata.signatures.customer)).toContain(await day(0));
    expect((await detail(id)).status).toBe("active_in_tg");
    expect(await caseItems(id)).toContain("evidence_invalidated");
    // Cleared once the current facts support the entry again (here: a second correction).
    expect(
      (await approve(await correctionId(await supersede(await day(-5), projectLead)))).status,
    ).toBe(204);
    expect(await caseItems(id)).not.toContain("evidence_invalidated");
  });
});
