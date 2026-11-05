import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  auditContext,
  call,
  informedParticipation,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
  textDates,
} from "./testing";

// Evidence corrections (data-protection.md, evidence corrections; D29, Q183, Q186, Q190, Q207 (6);
// readings Q209) as transfer_app calls the functions: the PL's request on an accepted document, an
// ASU registration or a closed BA reporting task; the regional operations manager's decision under
// four eyes; what an approval invalidates or supersedes and what it leaves alone. Synthetic values
// only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const { consultant, backOffice, projectLead, regionalOperationsManager } = seedStaffUserIds;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const asBackOffice = auditContext({ actorType: "user", staffUserId: backOffice });
const asManager = auditContext({ actorType: "user", staffUserId: regionalOperationsManager });
const { werkNord } = seedProjectIds;
const key = hex();
const keyId = hex(8);

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
const daysAgo = async (n: number) =>
  (await one(`select (berlin_today() - $1::int)::text as d`, [n])).d as string;

/** An informed Werk Nord participation (`ta_tg`), assigned to the consultant. */
async function participation() {
  const id = await informedParticipation(app);
  await call(app, "assign_participations", {
    projectId: werkNord,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  return id;
}

/** An `asu_proof` document added and, unless `reviewed` is false, accepted by the consultant. */
async function document(participationId: string, reviewed = true) {
  const id = await call(app, "add_document", {
    context: asConsultant,
    participationId,
    id: randomUUID(),
    type: "asu_proof",
    mediaType: "application/pdf",
    sizeBytes: 2048,
    contentSha256: createHash("sha256").update(randomUUID()).digest("hex"),
    fileName: null,
    keyId: hex(8),
    wrappedKey: randomBytes(60),
  });
  if (reviewed) {
    await call(app, "review_document", {
      context: asConsultant,
      documentId: id,
      decision: "accepted",
      reason: null,
    });
  }
  return id;
}

/** An `online_self` registration of `registeredOn` attested by the PL; its id. */
async function registration(participationId: string, registeredOn: string) {
  await call(app, "set_asu_route", {
    context: pl,
    participationId,
    channel: "online_self",
    version: 0,
  });
  return register(participationId, registeredOn);
}

const register = async (participationId: string, registeredOn: string) =>
  call(app, "record_asu_registration", {
    context: pl,
    participationId,
    id: randomUUID(),
    registeredOn,
    routeVersion: (
      await one("select version from asu_record where participation_id = $1", [participationId])
    ).version,
    customerNumber: "123A456789",
    attestationSource: "ba_online_account_inspected",
    key,
    keyId,
  });

/** A BA reporting task of the participation, closed `not_required` by the PL; its id. */
async function closedTask(participationId: string) {
  const taskId = randomUUID();
  await owner.query(
    `insert into ba_reporting_task (id, participation_id, project_id, reporting_kind, subject_date,
       created_at)
     values ($1, $2, $3, 'early_exit', berlin_today(), now() - interval '3 days')`,
    [taskId, participationId, werkNord],
  );
  await call(app, "record_ba_report", {
    context: pl,
    taskId,
    outcome: "not_required",
    reportedOn: null,
    reason: "created_in_error",
  });
  return taskId;
}

type Request = {
  participationId: string;
  targetKind: "document" | "asu_registration" | "ba_reporting_task";
  action?: "invalidate" | "supersede";
  targetId: string;
  wrongPerson?: boolean | null;
  registeredOn?: string | null;
  source?: string;
  context?: string;
};

const request = (args: Request) =>
  call(app, "request_evidence_correction", {
    context: args.context ?? pl,
    participationId: args.participationId,
    targetKind: args.targetKind,
    action: args.action ?? (args.targetKind === "ba_reporting_task" ? "supersede" : "invalidate"),
    targetId: args.targetId,
    wrongPerson:
      args.wrongPerson === undefined
        ? args.targetKind === "document"
          ? false
          : null
        : args.wrongPerson,
    correctedRegisteredOn: args.registeredOn ?? null,
    reason: "documented_internal_error",
    source: args.source ?? "  Vermerk   der PL vom 03.11. ",
  });

const decide = (correctionId: string, approve = true, context = asManager) =>
  call<string | null>(app, "decide_evidence_correction", { context, correctionId, approve });

const events = (id: string) =>
  all(
    `select event_type::text as type, actor_staff_user_id as actor, details from audit_event
     where participation_id = $1 and event_type::text like 'evidence_correction%' order by seq`,
    [id],
  );

/** The ordinary opening by the assigned consultant (who opens the ASU proof) in a live session. */
async function opening(documentId: string) {
  const sessionHash = hex();
  await call(app, "start_staff_session", {
    staffUserId: consultant,
    tokenHash: sessionHash,
    method: "dev",
    oidcIssuer: null,
    oidcSubject: null,
    supersededTokenHash: null,
    requestId: "req-login",
  });
  const linkHash = hex();
  await call(app, "open_document", {
    context: asConsultant,
    documentId,
    sessionKind: "staff",
    sessionHash,
    linkHash,
  });
  return { sessionHash, linkHash };
}

describe("request_evidence_correction (data-protection.md, evidence corrections; D29)", () => {
  it("records the PL's request with the normalised source, the target's class, audited with codes only", async () => {
    const id = await participation();
    const documentId = await document(id);
    const correctionId = await request({
      participationId: id,
      targetKind: "document",
      targetId: documentId,
    });
    expect(
      await one(
        `select target_kind::text, action::text, document_id, wrong_person, reason::text, source,
           retention_class, status::text, requested_by
         from evidence_correction where id = $1`,
        [correctionId],
      ),
    ).toEqual({
      target_kind: "document",
      action: "invalidate",
      document_id: documentId,
      wrong_person: false,
      reason: "documented_internal_error",
      source: "Vermerk der PL vom 03.11.",
      retention_class: (
        await one("select retention_class from document where id = $1", [documentId])
      ).retention_class,
      status: "requested",
      requested_by: projectLead,
    });
    expect(await events(id)).toEqual([
      {
        type: "evidence_correction_requested",
        actor: projectLead,
        details: {
          correctionId,
          targetKind: "document",
          action: "invalidate",
          reason: "documented_internal_error",
        },
      },
    ]);
    // A request alone changes nothing.
    expect(
      await one("select invalidated_by_correction from document where id = $1", [documentId]),
    ).toEqual({ invalidated_by_correction: null });
  });

  it("is the PL's (by the authority table), as themselves, on an accepted document, one at a time", async () => {
    const id = await participation();
    const documentId = await document(id);
    const target = { participationId: id, targetKind: "document", targetId: documentId } as const;
    for (const context of [asConsultant, asBackOffice, asManager]) {
      await expect(request({ ...target, context })).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
    const unreviewed = await document(id, false);
    await expect(request({ ...target, targetId: unreviewed })).rejects.toMatchObject(
      failsWith("document_not_accepted"),
    );
    await expect(request({ ...target, targetId: randomUUID() })).rejects.toMatchObject(
      failsWith("target_not_found"),
    );
    await expect(
      request({ ...target, participationId: await participation() }),
    ).rejects.toMatchObject(failsWith("target_not_found"));
    await expect(request({ ...target, source: " \n " })).rejects.toMatchObject(
      failsWith("source_invalid"),
    );
    await expect(request({ ...target, wrongPerson: null })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await request(target);
    await expect(request(target)).rejects.toMatchObject(failsWith("correction_pending"));
  });

  it("supersedes an ASU registration only with a changed date not in the future", async () => {
    const id = await participation();
    const registrationId = await registration(id, await daysAgo(10));
    const target = {
      participationId: id,
      targetKind: "asu_registration",
      action: "supersede",
      targetId: registrationId,
    } as const;
    await expect(request({ ...target, registeredOn: await daysAgo(10) })).rejects.toMatchObject(
      failsWith("correction_unchanged"),
    );
    await expect(request({ ...target, registeredOn: await daysAgo(-1) })).rejects.toMatchObject(
      failsWith("registered_on_in_future"),
    );
    await expect(request({ ...target, registeredOn: null })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await request({ ...target, registeredOn: await daysAgo(12) });
  });

  it("supersedes a closed BA outcome, never a pending task", async () => {
    const id = await participation();
    const pending = randomUUID();
    await owner.query(
      `insert into ba_reporting_task (id, participation_id, project_id, reporting_kind, subject_date)
       values ($1, $2, $3, 'early_exit', berlin_today())`,
      [pending, id, werkNord],
    );
    await expect(
      request({ participationId: id, targetKind: "ba_reporting_task", targetId: pending }),
    ).rejects.toMatchObject(failsWith("task_pending"));
    await expect(
      request({
        participationId: id,
        targetKind: "ba_reporting_task",
        action: "invalidate",
        targetId: await closedTask(id),
      }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
  });
});

describe("decide_evidence_correction (four eyes, D29, D31)", () => {
  it("is the regional operations manager's of the project's region, never the requester's", async () => {
    const id = await participation();
    const correctionId = await request({
      participationId: id,
      targetKind: "document",
      targetId: await document(id),
    });
    for (const context of [pl, asConsultant, asBackOffice]) {
      await expect(decide(correctionId, true, context)).rejects.toMatchObject(
        failsWith("actor_not_allowed"),
      );
    }
    // The requester holding the manager's role too still can't decide their own request.
    await owner.query(
      `insert into staff_org_role (staff_user_id, role, region_id)
       select $1, 'regional_operations_manager', region_id from project where id = $2`,
      [projectLead, werkNord],
    );
    await expect(decide(correctionId, true, pl)).rejects.toMatchObject(
      failsWith("same_person_approval"),
    );
    await expect(decide(randomUUID())).rejects.toMatchObject(failsWith("correction_not_found"));
  });

  it("rejects without changing anything; a decided request isn't decided again", async () => {
    const id = await participation();
    const documentId = await document(id);
    const correctionId = await request({
      participationId: id,
      targetKind: "document",
      targetId: documentId,
    });
    expect(await decide(correctionId, false)).toBeNull();
    expect(
      await one(
        `select d.invalidated_by_correction, d.deleted_at, c.status::text, c.decided_by
         from document d, evidence_correction c where d.id = $1 and c.id = $2`,
        [documentId, correctionId],
      ),
    ).toEqual({
      invalidated_by_correction: null,
      deleted_at: null,
      status: "rejected",
      decided_by: regionalOperationsManager,
    });
    await expect(decide(correctionId)).rejects.toMatchObject(failsWith("correction_not_pending"));
    // A new request after a rejection is possible.
    await request({ participationId: id, targetKind: "document", targetId: documentId });
  });

  it("invalidates a document: it opens for nobody, isn't quarantined or lifted, the request is append-only", async () => {
    const id = await participation();
    const documentId = await document(id);
    // Quarantined at once; the lift waits while the correction is pending.
    await call(app, "quarantine_document", {
      context: pl,
      documentId,
      reason: "suspected_wrong_acceptance",
    });
    const correctionId = await request({
      participationId: id,
      targetKind: "document",
      targetId: documentId,
    });
    await expect(
      call(app, "lift_document_quarantine", { context: pl, documentId }),
    ).rejects.toMatchObject(failsWith("correction_pending"));
    expect(await decide(correctionId)).toBeNull();
    expect(
      await one(
        "select invalidated_by_correction, deleted_at, file_name from document where id = $1",
        [documentId],
      ),
    ).toEqual({
      invalidated_by_correction: correctionId,
      deleted_at: null,
      file_name: null,
    });
    await expect(
      call(app, "lift_document_quarantine", { context: pl, documentId }),
    ).rejects.toMatchObject(failsWith("document_invalidated"));
    await expect(
      request({ participationId: id, targetKind: "document", targetId: documentId }),
    ).rejects.toMatchObject(failsWith("target_corrected"));
    await expect(
      owner.query("update evidence_correction set source = 'x' where id = $1", [correctionId]),
    ).rejects.toMatchObject(failsWith("correction_immutable"));
    await expect(
      owner.query("delete from evidence_correction where id = $1", [correctionId]),
    ).rejects.toMatchObject(failsWith("correction_immutable"));
  });

  it("refuses the ordinary opening of an invalidated document and quarantining it again", async () => {
    const id = await participation();
    const documentId = await document(id);
    // Opened before: its link answers nothing once the document is invalidated.
    const before = await opening(documentId);
    const content = () =>
      app
        .query("select document_id from document_link_content($1, 'staff', $2)", [
          before.linkHash,
          before.sessionHash,
        ])
        .then((r) => r.rows.length);
    expect(await content()).toBe(1);
    await decide(
      await request({ participationId: id, targetKind: "document", targetId: documentId }),
    );
    expect(await content()).toBe(0);
    await expect(opening(documentId)).rejects.toMatchObject(failsWith("document_invalidated"));
    await expect(
      call(app, "quarantine_document", {
        context: pl,
        documentId,
        reason: "suspected_wrong_person",
      }),
    ).rejects.toMatchObject(failsWith("document_invalidated"));
  });

  it("makes a wrong person's file a tombstone to purge; the history stays", async () => {
    const id = await participation();
    const documentId = await document(id);
    const correctionId = await request({
      participationId: id,
      targetKind: "document",
      targetId: documentId,
      wrongPerson: true,
    });
    expect(await decide(correctionId)).toBe(documentId);
    expect(
      await one(
        `select invalidated_by_correction, deleted_at is not null as deleted, deleted_by::text,
           deleted_by_staff_user_id, delete_reason::text, file_name, purged_at
         from document where id = $1`,
        [documentId],
      ),
    ).toEqual({
      invalidated_by_correction: correctionId,
      deleted: true,
      deleted_by: "user",
      deleted_by_staff_user_id: regionalOperationsManager,
      delete_reason: "wrong_person",
      file_name: null,
      purged_at: null,
    });
    expect((await events(id)).map((e) => [e.type, e.details.decision ?? null])).toEqual([
      ["evidence_correction_requested", null],
      ["evidence_correction_decided", "approved"],
    ]);
  });

  it("supersedes an ASU registration with the corrected date, recorded and proven at the approval instant", async () => {
    const id = await participation();
    const registrationId = await registration(id, await daysAgo(10));
    const corrected = await daysAgo(12);
    const correctionId = await request({
      participationId: id,
      targetKind: "asu_registration",
      action: "supersede",
      targetId: registrationId,
      registeredOn: corrected,
    });
    await decide(correctionId);
    const rows = await all(
      `select g.id, g.registered_on, g.superseded_by, g.correction_id, g.proof_kind::text,
         g.attestation_source::text, g.recorded_at = c.decided_at as recorded_at_approval,
         g.proof_linked_at = c.decided_at as proven_at_approval, g.recorded_by
       from asu_registration g, evidence_correction c
       where g.participation_id = $1 and c.id = $2 order by g.recorded_at`,
      [id, correctionId],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        id: registrationId,
        superseded_by: correctionId,
        correction_id: null,
      }),
      {
        id: expect.any(String),
        registered_on: corrected,
        superseded_by: null,
        correction_id: correctionId,
        proof_kind: "ba_customer_number",
        attestation_source: "ba_online_account_inspected",
        recorded_at_approval: true,
        proven_at_approval: true,
        recorded_by: regionalOperationsManager,
      },
    ]);
    // Still one current registration: no duplicate, the route stays fixed.
    await expect(register(id, corrected)).rejects.toMatchObject(failsWith("asu_registered"));
    await expect(
      request({
        participationId: id,
        targetKind: "asu_registration",
        targetId: registrationId,
      }),
    ).rejects.toMatchObject(failsWith("target_corrected"));
  });

  it("supersedes a registration proven by a BA confirmation without its proof, until it is linked again", async () => {
    const id = await participation();
    await call(app, "set_asu_route", {
      context: pl,
      participationId: id,
      channel: "in_person",
      version: 0,
    });
    const registrationId = await call(app, "record_asu_registration", {
      context: asConsultant,
      participationId: id,
      id: randomUUID(),
      registeredOn: await daysAgo(10),
      routeVersion: 1,
    });
    const proof = await document(id);
    const link = (target: string) =>
      call(app, "link_asu_proof", {
        context: asConsultant,
        participationId: id,
        registrationId: target,
        documentId: proof,
      });
    await link(registrationId);
    await decide(
      await request({
        participationId: id,
        targetKind: "asu_registration",
        action: "supersede",
        targetId: registrationId,
        registeredOn: await daysAgo(12),
      }),
    );
    const current = await one(
      `select id, proof_kind, proof_document_id from asu_registration
       where participation_id = $1 and superseded_by is null and invalidated_by is null`,
      [id],
    );
    expect(current).toMatchObject({ proof_kind: null, proof_document_id: null });
    // The consultant confirms the document supports the corrected date by linking it again.
    await link(current.id);
    expect(
      await one("select proof_kind::text from asu_registration where id = $1", [current.id]),
    ).toEqual({ proof_kind: "ba_confirmation" });
  });

  it("invalidates an ASU registration: it stays, linked, and a new one may be recorded", async () => {
    const id = await participation();
    const registrationId = await registration(id, await daysAgo(10));
    const correctionId = await request({
      participationId: id,
      targetKind: "asu_registration",
      targetId: registrationId,
    });
    await decide(correctionId);
    expect(
      await one("select invalidated_by from asu_registration where id = $1", [registrationId]),
    ).toEqual({ invalidated_by: correctionId });
    await expect(
      call(app, "link_asu_proof", {
        context: asConsultant,
        participationId: id,
        registrationId,
        documentId: await document(id),
      }),
    ).rejects.toMatchObject(failsWith("asu_registration_corrected"));
    await call(app, "set_asu_route", {
      context: pl,
      participationId: id,
      channel: "in_person",
      version: 1,
    });
    await register(id, await daysAgo(2));
    expect(
      await one(
        `select count(*)::int as n from asu_registration
         where participation_id = $1 and superseded_by is null and invalidated_by is null`,
        [id],
      ),
    ).toEqual({ n: 1 });
  });

  it("supersedes a BA outcome by a linked pending replacement; the original's stale dialog is refused (Q207 (6))", async () => {
    const id = await participation();
    const taskId = await closedTask(id);
    const correctionId = await request({
      participationId: id,
      targetKind: "ba_reporting_task",
      targetId: taskId,
    });
    await decide(correctionId);
    const tasks = await all(
      `select id, status::text, not_required_reason::text, superseded_by, replaces_task_id,
         correction_id
       from ba_reporting_task where participation_id = $1 order by created_at`,
      [id],
    );
    const replacement = tasks[1].id as string;
    expect(tasks).toEqual([
      {
        id: taskId,
        status: "not_required",
        not_required_reason: "created_in_error",
        superseded_by: replacement,
        replaces_task_id: null,
        correction_id: null,
      },
      {
        id: replacement,
        status: "pending",
        not_required_reason: null,
        superseded_by: null,
        replaces_task_id: taskId,
        correction_id: correctionId,
      },
    ]);
    // A dialog still open for the original records nothing: only the replacement is open.
    await expect(
      call(app, "record_ba_report", {
        context: pl,
        taskId,
        outcome: "reported",
        reportedOn: await daysAgo(0),
        reason: null,
      }),
    ).rejects.toMatchObject(failsWith("already_recorded"));
    // The replacement reports the same obligation: a report sent before the correction, after
    // the original task's day, keeps its true date (the review of PR #103); never earlier.
    const report = async (task: string, days: number) =>
      call(app, "record_ba_report", {
        context: pl,
        taskId: task,
        outcome: "reported",
        reportedOn: await daysAgo(days),
        reason: null,
      });
    await expect(report(replacement, 4)).rejects.toMatchObject(failsWith("date_before_task"));
    await report(replacement, 2);
    // A second correction: its replacement still dates from the first task's day.
    await decide(
      await request({
        participationId: id,
        targetKind: "ba_reporting_task",
        targetId: replacement,
      }),
    );
    const second = (
      await one("select id from ba_reporting_task where replaces_task_id = $1", [replacement])
    ).id as string;
    await expect(report(second, 4)).rejects.toMatchObject(failsWith("date_before_task"));
    await report(second, 3);
    // The original's outcome is never edited, and its link is set once.
    await expect(
      owner.query("update ba_reporting_task set superseded_by = null where id = $1", [taskId]),
    ).rejects.toMatchObject(failsWith("task_immutable"));
  });

  it("moves no status (data-protection.md, evidence corrections)", async () => {
    const id = await participation();
    const status = () =>
      one("select status, profiling_status, dsv_status from participation where id = $1", [id]);
    const before = await status();
    await decide(
      await request({ participationId: id, targetKind: "document", targetId: await document(id) }),
    );
    expect(await status()).toEqual(before);
  });
});
