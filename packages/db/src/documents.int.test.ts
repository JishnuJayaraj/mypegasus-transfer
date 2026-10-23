import { documentTypeCatalog, type DocumentTypeEntry } from "@transfer/domain";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { retentionPeriods } from "./data-catalog";
import { seedProjectIds, seedStaffUserIds } from "./seed";
import {
  auditContext,
  call,
  changeStatus,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "./testing";

// The document functions (ADR-0002, documents; data-protection.md, uploads and documents;
// Q142–Q148) as transfer_app calls them: who adds, opens, reviews and deletes, the limits, the
// links bound to a session, and the audit entries with ids and codes only. Synthetic values only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const projectId = seedProjectIds.werkNord;
const FILE_NAME = "Lebenslauf Erika Beispiel.pdf";

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
const one = async (sql: string, params: unknown[] = []) => (await all(sql, params))[0];

/** A participation with an activation code issued; returns the code's hash. */
async function issued() {
  const participationId = await call(app, "create_participation", { projectId, context: pl });
  await owner.query(
    `insert into participant_identity
       (participation_id, project_id, personnel_number, last_name, first_name, birth_date)
     values ($1, $2, $3, 'Beispiel', 'Erika', '1970-01-01')`,
    [participationId, projectId, `SYN-${participationId.slice(-8)}`],
  );
  await owner.query(
    `insert into participant_details (participation_id, project_id, address_street,
       address_postal_code, address_city, address_country)
     values ($1, $2, 'Musterweg 1', '10115', 'Berlin', 'DE')`,
    [participationId, projectId],
  );
  const codeHash = hex();
  await call(app, "issue_activation_code", {
    participationId,
    codeHash,
    channel: "letter",
    language: "de",
    noticeVersion: "art14-activation:v1",
    replaceOpenCode: false,
    deliveryKind: null,
    deliveryAddressHash: null,
    identityChecked: false,
    context: pl,
    id: randomUUID(),
    purpose: "activation",
  });
  const activating = hex();
  await call(app, "start_activation", { codeHash, tokenHash: activating, requestId: "req-1" });
  return { participationId, activating };
}

/** An activated participant with a live active session. */
async function activated() {
  const { participationId, activating } = await issued();
  await call(app, "check_activation_birth_date", {
    tokenHash: activating,
    birthDate: "1970-01-01",
    requestId: "req-2",
  });
  const oneTimeCodeHash = hex();
  await call(app, "create_one_time_code", {
    tokenHash: activating,
    kind: "email",
    address: `erika-${participationId.slice(-8)}@example.invalid`,
    codeHash: oneTimeCodeHash,
    id: randomUUID(),
  });
  const session = hex();
  await call(app, "complete_activation", {
    tokenHash: activating,
    newTokenHash: session,
    noticeVersion: "art14-activation:v1",
    consentVersion: "portal-contact-consent:v2",
    language: "de",
    channelId: randomUUID(),
    consentId: randomUUID(),
    requestId: "req-3",
    oneTimeCodeHash,
  });
  const context = auditContext({ actorType: "participant", participationId, requestId: "req-p" });
  return { participationId, session, context };
}
type Participant = Awaited<ReturnType<typeof activated>>;

async function staffSession(staffUserId: string) {
  const tokenHash = hex();
  await call(app, "start_staff_session", {
    staffUserId,
    tokenHash,
    method: "dev",
    oidcIssuer: null,
    oidcSubject: null,
    supersededTokenHash: null,
    requestId: "req-login",
  });
  return tokenHash;
}

const staff = (staffUserId: string) =>
  auditContext({ actorType: "user", staffUserId, requestId: "req-staff" });
const onBehalf = (staffUserId: string, participationId: string) =>
  auditContext({ actorType: "user", staffUserId, onBehalfOf: participationId, requestId: "req-a" });
const lead = staff(seedStaffUserIds.projectLead);
const consultant = staff(seedStaffUserIds.consultant);
const backOffice = staff(seedStaffUserIds.backOffice);

const assign = (participationId: string) =>
  owner.query(
    `insert into participant_assignment (project_id, participation_id, staff_user_id, assigned_by)
     values ($1, $2, $3, $4)`,
    [projectId, participationId, seedStaffUserIds.consultant, seedStaffUserIds.projectLead],
  );

type Add = {
  context: string;
  participationId: string;
  type?: string;
  fileName?: string | null;
  tokenHash?: string | null;
  id?: string;
};
const add = (a: Add) =>
  call(app, "add_document", {
    context: a.context,
    participationId: a.participationId,
    id: a.id ?? randomUUID(),
    type: a.type ?? "cv",
    mediaType: "application/pdf",
    sizeBytes: 1234,
    contentSha256: hex(),
    fileName: a.fileName === undefined ? FILE_NAME : a.fileName,
    keyId: hex(8),
    wrappedKey: randomBytes(60),
    tokenHash: a.tokenHash ?? null,
  });
const byParticipant = (p: Participant, extra: Partial<Add> = {}) =>
  add({ context: p.context, participationId: p.participationId, tokenHash: p.session, ...extra });

const open = (context: string, documentId: string, kind: string, sessionHash: string) => {
  const linkHash = hex();
  return call(app, "open_document", {
    context,
    documentId,
    sessionKind: kind,
    sessionHash,
    linkHash,
  }).then((expiresAt) => ({ expiresAt, linkHash }));
};
const content = (linkHash: string, kind: string, sessionHash: string) =>
  app
    .query(
      "select * from document_link_content(p_link_hash => $1, p_session_kind => $2, p_session_hash => $3)",
      [linkHash, kind, sessionHash],
    )
    .then((r) => r.rows);
const review = (context: string, documentId: string, decision: string, reason: string | null) =>
  call(app, "review_document", { context, documentId, decision, reason });
const remove = (context: string, documentId: string, reason: string | null, tokenHash?: string) =>
  call(app, "delete_document", { context, documentId, reason, tokenHash: tokenHash ?? null });

const events = (participationId: string) =>
  all(
    `select event_type, actor_type, actor_staff_user_id, on_behalf_of_participation_id,
       reason_code, details
     from audit_event where participation_id = $1 and event_type::text like 'document%'
     order by seq`,
    [participationId],
  );

async function withdraw(participationId: string) {
  let { status } = await one("select status from participation where id = $1", [participationId]);
  if (status === "imported") {
    await changeStatus(app, participationId, { field: "status", from: status, to: "contacted" });
    status = "contacted";
  }
  await changeStatus(app, participationId, {
    field: "status",
    from: status,
    to: "withdrawn",
    endReason: "other",
    effectiveDate: "2026-10-22",
  });
}

const roles = (entry: DocumentTypeEntry, op: "add" | "review" | "delete") =>
  entry.operations === "undecided" ? [] : [...entry.operations[op]];

describe("document_type_policy", () => {
  it("is the domain's catalog, version by version (drift)", async () => {
    const rows = await all(
      `select type::text, catalog_version, retention_class, file_name, signed, add_roles,
         review_roles, delete_roles, open_roles
       from document_type_policy order by catalog_version, type`,
    );
    const expected = documentTypeCatalog.types.map((entry) => ({
      type: entry.type,
      catalog_version: documentTypeCatalog.version,
      retention_class: entry.retentionClass,
      file_name: entry.fileName,
      signed: entry.signed,
      add_roles: roles(entry, "add"),
      review_roles: roles(entry, "review"),
      delete_roles: roles(entry, "delete"),
      open_roles: Object.entries(entry.roles)
        .filter(([, right]) => right === "open")
        .map(([role]) => role),
    }));
    const sorted = (list: typeof expected) =>
      list
        .map((row) => ({
          ...row,
          add_roles: row.add_roles.toSorted(),
          review_roles: row.review_roles.toSorted(),
          delete_roles: row.delete_roles.toSorted(),
          open_roles: row.open_roles.toSorted(),
        }))
        .toSorted((a, b) => a.type.localeCompare(b.type));
    expect(sorted(rows)).toEqual(sorted(expected));
    for (const row of rows) expect(Object.keys(retentionPeriods)).toContain(row.retention_class);
  });
});

describe("add_document (Q146)", () => {
  let p: Participant;
  beforeEach(async () => {
    p = await activated();
  });

  it("stores the participant's upload with its type's class, audited without the file name", async () => {
    const id = await byParticipant(p);
    expect(
      await one(
        `select type, catalog_version, retention_class, file_name, added_by, added_by_staff_user_id,
           added_on_behalf, review_state from document where id = $1`,
        [id],
      ),
    ).toEqual({
      type: "cv",
      catalog_version: 2,
      retention_class: "personnel_file",
      file_name: FILE_NAME,
      added_by: "participant",
      added_by_staff_user_id: null,
      added_on_behalf: false,
      review_state: "unreviewed",
    });
    expect(await events(p.participationId)).toEqual([
      {
        event_type: "document_added",
        actor_type: "participant",
        actor_staff_user_id: null,
        on_behalf_of_participation_id: null,
        reason_code: null,
        details: { documentId: id, documentType: "cv", source: "portal" },
      },
    ]);
  });

  it("lets the PL and the assigned consultant add as themselves; refuses the others", async () => {
    await add({ context: lead, participationId: p.participationId });
    await expect(
      add({ context: consultant, participationId: p.participationId }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await assign(p.participationId);
    await add({
      context: consultant,
      participationId: p.participationId,
      type: "qualification_certificate",
    });
    await expect(
      add({ context: backOffice, participationId: p.participationId }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await expect(
      add({ context: staff(seedStaffUserIds.admin), participationId: p.participationId }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    expect(
      (await events(p.participationId)).map((e) => [e.actor_staff_user_id, e.details.source]),
    ).toEqual([
      [seedStaffUserIds.projectLead, "staff"],
      [seedStaffUserIds.consultant, "staff"],
    ]);
  });

  it("adds in assisted mode through the live mode, as actor and onBehalfOf", async () => {
    const session = await staffSession(seedStaffUserIds.projectLead);
    const context = onBehalf(seedStaffUserIds.projectLead, p.participationId);
    await expect(
      add({ context, participationId: p.participationId, tokenHash: session }),
    ).rejects.toMatchObject(failsWith("assisted_mode_required"));
    await call(app, "start_assisted_mode", {
      participationId: p.participationId,
      context: lead,
      staffSessionHash: session,
      how: "phone",
      id: randomUUID(),
    });
    const id = await add({ context, participationId: p.participationId, tokenHash: session });
    expect(await one("select added_by, added_on_behalf from document where id = $1", [id])).toEqual(
      { added_by: "user", added_on_behalf: true },
    );
    expect((await events(p.participationId)).at(-1)).toMatchObject({
      actor_staff_user_id: seedStaffUserIds.projectLead,
      on_behalf_of_participation_id: p.participationId,
      details: { source: "assisted" },
    });
    // Back office may use assisted mode, but adds no document (Q146).
    const boSession = await staffSession(seedStaffUserIds.backOffice);
    await call(app, "start_assisted_mode", {
      participationId: p.participationId,
      context: backOffice,
      staffSessionHash: boSession,
      how: "phone",
      id: randomUUID(),
    });
    await expect(
      add({
        context: onBehalf(seedStaffUserIds.backOffice, p.participationId),
        participationId: p.participationId,
        tokenHash: boSession,
      }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
  });

  it("refuses an activating, dead or foreign session", async () => {
    const pending = await issued();
    await expect(
      add({
        context: auditContext({
          actorType: "participant",
          participationId: pending.participationId,
        }),
        participationId: pending.participationId,
        tokenHash: pending.activating,
      }),
    ).rejects.toMatchObject(failsWith("session_invalid"));
    const other = await activated();
    await expect(byParticipant(p, { tokenHash: other.session })).rejects.toMatchObject(
      failsWith("session_invalid"),
    );
    await expect(byParticipant(p, { tokenHash: null })).rejects.toMatchObject(
      failsWith("session_invalid"),
    );
    await expect(
      add({ context: p.context, participationId: other.participationId, tokenHash: other.session }),
    ).rejects.toMatchObject(failsWith("invalid_actor"));
  });

  it("refuses an undecided type, a closed participation and a name for a type that keeps none", async () => {
    await expect(byParticipant(p, { type: "asu_proof", fileName: null })).rejects.toMatchObject(
      failsWith("document_type_not_supported"),
    );
    await expect(
      add({
        context: lead,
        participationId: p.participationId,
        type: "dsv_signed_scan",
        fileName: null,
      }),
    ).rejects.toMatchObject(failsWith("document_type_not_supported"));
    await expect(byParticipant(p, { fileName: "a\u0007b.pdf" })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await expect(byParticipant(p, { fileName: "x".repeat(201) })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    const closed = await call(app, "create_participation", { projectId, context: pl });
    await withdraw(closed);
    await expect(add({ context: lead, participationId: closed })).rejects.toMatchObject(
      failsWith("participation_closed"),
    );
  });

  it("allows 50 live documents and 20 uploads an hour (Q143)", async () => {
    for (let i = 0; i < 20; i += 1)
      await add({ context: lead, participationId: p.participationId });
    await expect(add({ context: lead, participationId: p.participationId })).rejects.toMatchObject(
      failsWith("upload_rate_limited"),
    );
    await owner.query("update document set added_at = added_at - interval '2 hours'");
    for (let i = 0; i < 20; i += 1)
      await add({ context: lead, participationId: p.participationId });
    await owner.query("update document set added_at = added_at - interval '2 hours'");
    for (let i = 0; i < 10; i += 1)
      await add({ context: lead, participationId: p.participationId });
    await expect(add({ context: lead, participationId: p.participationId })).rejects.toMatchObject(
      failsWith("document_limit"),
    );
    const [first] = await all("select id from document order by added_at limit 1");
    await remove(lead, first.id, "duplicate");
    await add({ context: lead, participationId: p.participationId });
  });
});

describe("record_document_upload_rejected (Q144)", () => {
  it("records the type and the code only, after the same actor checks", async () => {
    const p = await activated();
    await call(app, "record_document_upload_rejected", {
      context: p.context,
      participationId: p.participationId,
      type: "cv",
      code: "file_infected",
      tokenHash: p.session,
    });
    expect(await events(p.participationId)).toEqual([
      expect.objectContaining({
        event_type: "document_upload_rejected",
        actor_type: "participant",
        reason_code: "file_infected",
        details: { documentType: "cv" },
      }),
    ]);
    expect(await all("select id from document")).toEqual([]);
    await expect(
      call(app, "record_document_upload_rejected", {
        context: backOffice,
        participationId: p.participationId,
        type: "cv",
        code: "file_unscannable",
      }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await expect(
      call(app, "record_document_upload_rejected", {
        context: lead,
        participationId: p.participationId,
        type: "cv",
        code: "file_too_large",
      }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
  });
});

describe("open_document and document_link_content (Q147)", () => {
  let p: Participant;
  let documentId: string;
  let leadSession: string;
  beforeEach(async () => {
    p = await activated();
    documentId = await byParticipant(p);
    leadSession = await staffSession(seedStaffUserIds.projectLead);
  });

  it("audits each opening and returns the file's keys only for that live session's link", async () => {
    const { linkHash, expiresAt } = await open(p.context, documentId, "participant", p.session);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(50_000);
    const rows = await content(linkHash, "participant", p.session);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      document_id: documentId,
      participation_id: p.participationId,
      document_type: "cv",
      media_type: "application/pdf",
      file_name: FILE_NAME,
    });
    expect(rows[0].wrapped_key).toHaveLength(60);
    // Reusable within the 60 s, never by another session.
    expect(await content(linkHash, "participant", p.session)).toHaveLength(1);
    expect(await content(linkHash, "staff", p.session)).toEqual([]);
    expect(await content(linkHash, "participant", hex())).toEqual([]);
    await open(lead, documentId, "staff", leadSession);
    expect(
      (await events(p.participationId)).filter((e) => e.event_type === "document_opened"),
    ).toEqual([
      expect.objectContaining({
        actor_type: "participant",
        details: { documentType: "cv", documentId },
      }),
      expect.objectContaining({
        actor_staff_user_id: seedStaffUserIds.projectLead,
        details: { documentType: "cv", documentId },
      }),
    ]);
    await owner.query(
      "update document_link set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 second'",
    );
    expect(await content(linkHash, "participant", p.session)).toEqual([]);
  });

  it("ends with the session and with the document", async () => {
    const staffLink = await open(lead, documentId, "staff", leadSession);
    await call(app, "end_staff_session", { tokenHash: leadSession, requestId: "req-out" });
    expect(await content(staffLink.linkHash, "staff", leadSession)).toEqual([]);
    const { linkHash } = await open(p.context, documentId, "participant", p.session);
    await remove(lead, documentId, "wrong_file");
    expect(await content(linkHash, "participant", p.session)).toEqual([]);
    await expect(open(p.context, documentId, "participant", p.session)).rejects.toMatchObject(
      failsWith("document_not_found"),
    );
  });

  it("refuses back office, an unassigned consultant, another staff user's session and a wrong kind", async () => {
    const boSession = await staffSession(seedStaffUserIds.backOffice);
    await expect(open(backOffice, documentId, "staff", boSession)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    const cSession = await staffSession(seedStaffUserIds.consultant);
    await expect(open(consultant, documentId, "staff", cSession)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await assign(p.participationId);
    await open(consultant, documentId, "staff", cSession);
    await expect(open(consultant, documentId, "staff", leadSession)).rejects.toMatchObject(
      failsWith("session_invalid"),
    );
    await expect(open(lead, documentId, "participant", leadSession)).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    const other = await activated();
    await expect(
      open(other.context, documentId, "participant", other.session),
    ).rejects.toMatchObject(failsWith("invalid_actor"));
  });

  it("opens in assisted mode through the live mode of the session", async () => {
    const context = onBehalf(seedStaffUserIds.projectLead, p.participationId);
    await expect(open(context, documentId, "staff", leadSession)).rejects.toMatchObject(
      failsWith("assisted_mode_required"),
    );
    await call(app, "start_assisted_mode", {
      participationId: p.participationId,
      context: lead,
      staffSessionHash: leadSession,
      how: "in_person",
      id: randomUUID(),
    });
    const { linkHash } = await open(context, documentId, "staff", leadSession);
    expect(await content(linkHash, "staff", leadSession)).toHaveLength(1);
  });
});

describe("review_document (process-and-lifecycle.md, document review)", () => {
  let p: Participant;
  let documentId: string;
  beforeEach(async () => {
    p = await activated();
    documentId = await byParticipant(p);
  });

  it("reviews once and finally, by the assigned consultant or the PL in normal mode", async () => {
    await expect(review(consultant, documentId, "accepted", null)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(review(backOffice, documentId, "accepted", null)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(
      review(
        onBehalf(seedStaffUserIds.projectLead, p.participationId),
        documentId,
        "accepted",
        null,
      ),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await expect(review(lead, documentId, "rejected", null)).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await assign(p.participationId);
    await review(consultant, documentId, "rejected", "unreadable");
    await expect(review(lead, documentId, "accepted", null)).rejects.toMatchObject(
      failsWith("document_reviewed"),
    );
    expect(
      await one("select review_state, review_reason, reviewed_by from document where id = $1", [
        documentId,
      ]),
    ).toEqual({
      review_state: "rejected",
      review_reason: "unreadable",
      reviewed_by: seedStaffUserIds.consultant,
    });
    expect((await events(p.participationId)).at(-1)).toMatchObject({
      event_type: "document_reviewed",
      reason_code: "unreadable",
      details: { documentId, documentType: "cv", decision: "rejected" },
    });
  });
});

describe("delete_document and record_document_purged (Q146)", () => {
  let p: Participant;
  beforeEach(async () => {
    p = await activated();
  });

  it("lets the participant delete their own while not accepted, without a reason", async () => {
    const own = await byParticipant(p);
    const byStaff = await add({ context: lead, participationId: p.participationId });
    const accepted = await byParticipant(p);
    await review(lead, accepted, "accepted", null);
    await expect(remove(p.context, own, "duplicate", p.session)).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await expect(remove(p.context, byStaff, null, p.session)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(remove(p.context, accepted, null, p.session)).rejects.toMatchObject(
      failsWith("document_accepted"),
    );
    await remove(p.context, own, null, p.session);
    expect(
      await one(
        `select file_name, deleted_by, delete_reason, deleted_at is not null as deleted, purged_at
         from document where id = $1`,
        [own],
      ),
    ).toEqual({
      file_name: null,
      deleted_by: "participant",
      delete_reason: null,
      deleted: true,
      purged_at: null,
    });
    await expect(remove(p.context, own, null, p.session)).rejects.toMatchObject(
      failsWith("document_not_found"),
    );
  });

  it("lets the PL and the assigned consultant delete any with a reason, also after the exit", async () => {
    const accepted = await byParticipant(p);
    await review(lead, accepted, "accepted", null);
    await expect(remove(lead, accepted, null)).rejects.toMatchObject(failsWith("invalid_argument"));
    await expect(remove(consultant, accepted, "wrong_person")).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(remove(backOffice, accepted, "wrong_person")).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(
      remove(onBehalf(seedStaffUserIds.projectLead, p.participationId), accepted, "wrong_person"),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await assign(p.participationId);
    const second = await byParticipant(p);
    await withdraw(p.participationId);
    await remove(lead, accepted, "wrong_person");
    await remove(consultant, second, "participant_request");
    expect(
      (await events(p.participationId))
        .filter((e) => e.event_type === "document_deleted")
        .map((e) => [e.actor_staff_user_id, e.reason_code, e.details]),
    ).toEqual([
      [seedStaffUserIds.projectLead, "wrong_person", { documentId: accepted, documentType: "cv" }],
      [
        seedStaffUserIds.consultant,
        "participant_request",
        { documentId: second, documentType: "cv" },
      ],
    ]);
  });

  it("records the purge once, and never for a live document", async () => {
    const id = await byParticipant(p);
    await expect(call(app, "record_document_purged", { documentId: id })).rejects.toMatchObject(
      failsWith("document_not_deleted"),
    );
    await remove(lead, id, "wrong_file");
    expect(await call(app, "record_document_purged", { documentId: id })).toBe(true);
    expect(await call(app, "record_document_purged", { documentId: id })).toBe(false);
    expect(
      await one("select purged_at is not null as purged from document where id = $1", [id]),
    ).toEqual({
      purged: true,
    });
  });

  it("never puts a file name into the audit trail and keeps the document events reserved", async () => {
    const id = await byParticipant(p);
    await open(p.context, id, "participant", p.session);
    await remove(lead, id, "wrong_file");
    const trail = JSON.stringify(await all("select * from audit_event"));
    expect(trail).not.toContain("Lebenslauf");
    for (const type of ["document_opened", "document_added", "document_deleted"]) {
      await expect(
        call(app, "record_audit_event", {
          projectId,
          participationId: p.participationId,
          eventType: type,
          context: lead,
        }),
      ).rejects.toMatchObject(failsWith("event_type_reserved"));
    }
  });
});
