import { workingCopyExpiry } from "@transfer/domain";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  textDates,
} from "./testing";

// Signed TL 407 scans (data-protection.md, signed scans, signed declarations and quarantine;
// process-and-lifecycle.md, profiling track; Q183–Q185, Q191, Q193) as transfer_app calls the
// functions: the origin at the upload, the review's record and the signed declarations, the PL's
// deletion before review, quarantine and its lift, the TL 407 facts and `profiling_done`.
// Synthetic values only; the files are the API's.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const other = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const { consultant, backOffice } = seedStaffUserIds;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const asBackOffice = auditContext({ actorType: "user", staffUserId: backOffice });
const { verwaltung } = seedProjectIds;
const both = ["signatures_present", "all_pages_present"];

beforeAll(() => Promise.all([app.connect(), other.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), other.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
const today = async () => (await one("select berlin_today()::text as d")).d as string;
const daysAgo = async (n: number) =>
  (await one(`select (berlin_today() - $1::int)::text as d`, [n])).d as string;

/** An informed participation of Verwaltung (`ta_only`), assigned to the consultant. */
async function participation() {
  const id = await call(app, "create_participation", { projectId: verwaltung, context: pl });
  await changeStatus(app, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(app, id, { field: "status", from: "contacted", to: "informed" });
  await call(app, "assign_participations", {
    projectId: verwaltung,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  return id;
}

const person = {
  firstName: "",
  lastName: "",
  birthDate: null,
  street: null,
  postalCode: null,
  city: null,
  country: null,
  phone: null,
  mobile: null,
  privateEmail: null,
  tgStart: null,
  tgEnd: null,
};

/** A generated TL 407 printing the declarations recorded as pending: its document id. */
async function generate(id: string) {
  await call(app, "write_profiling_declarations", {
    participationId: id,
    context: asConsultant,
    jobboerseChoice: "anonymous_callme",
    baContactConsent: true,
    revision: 0,
  });
  const documentId = randomUUID();
  await call(app, "record_form_generation", {
    context: asConsultant,
    participationId: id,
    generationId: randomUUID(),
    documentId,
    formCode: "tl407",
    formVersion: "08-2025",
    sources: JSON.stringify({ profile: 0, profiling: 1, assessment: 0, unemployment: 0 }),
    person: JSON.stringify(person),
    sourceToken: hex(),
    organisationSha256: hex(),
    declarations: JSON.stringify({ jobboerseChoice: "anonymous_callme", baContactConsent: true }),
    confirmedWarnings: [],
    anlage: true,
    sizeBytes: 2048,
    contentSha256: hex(),
    keyId: hex(8),
    wrappedKey: randomBytes(60),
  });
  return documentId;
}

/** A scan stored by the consultant; its id. */
function scan(
  id: string,
  origin: "generated" | "external_paper",
  generationDocumentId: string | null = null,
  context = asConsultant,
) {
  return call(app, "add_document", {
    context,
    participationId: id,
    id: randomUUID(),
    type: "tl407_signed_scan",
    mediaType: "application/pdf",
    sizeBytes: 4096,
    contentSha256: createHash("sha256").update(randomUUID()).digest("hex"),
    fileName: null,
    keyId: hex(8),
    wrappedKey: randomBytes(60),
    scanOrigin: origin,
    generationDocumentId,
  });
}

type Review = {
  signedOn?: string;
  countersignedOn?: string;
  confirmations?: string[] | null;
  formVersion?: string | null;
  declarations?: object;
  context?: string;
};

async function accept(documentId: string, review: Review = {}) {
  const signedOn = review.signedOn ?? (await today());
  return call(app, "review_document", {
    context: review.context ?? asConsultant,
    documentId,
    decision: "accepted",
    reason: null,
    signedOn,
    countersignedOn: review.countersignedOn ?? signedOn,
    confirmations: review.confirmations === undefined ? both : review.confirmations,
    formVersion: review.formVersion ?? null,
    declarations: JSON.stringify(review.declarations ?? { kind: "as_printed" }),
  });
}

const declarationsOf = (documentId: string) =>
  all(
    `select declaration, value, form_code::text, form_version, signed_on::text
     from signed_declaration where document_id = $1 order by declaration`,
    [documentId],
  );
const facts = async (id: string) =>
  (
    await app.query(
      `select tl407_signed_on, tl407_recorded_at, profiling_done_on, profiling_done_recorded_at
       from tl407_facts(array[$1]::uuid[])`,
      [id],
    )
  ).rows[0] ?? null;
const done = (id: string, effectiveDate: string, context = asConsultant) =>
  changeStatus(app, id, {
    field: "profiling_status",
    from: "profiling_in_progress",
    to: "profiling_done",
    effectiveDate,
    context,
  });
async function inProgress(id: string) {
  await changeStatus(app, id, {
    field: "profiling_status",
    from: "not_started",
    to: "profiling_accepted",
  });
  await changeStatus(app, id, {
    field: "profiling_status",
    from: "profiling_accepted",
    to: "profiling_in_progress",
  });
}

describe("add_document for a signed scan (Q184)", () => {
  it("takes a generated scan's form and version from its generation", async () => {
    const id = await participation();
    const generation = await generate(id);
    const documentId = await scan(id, "generated", generation);
    expect(
      await one(
        `select catalog_version, retention_class, scan_origin::text, generation_document_id,
           form_code::text, form_version from document where id = $1`,
        [documentId],
      ),
    ).toEqual({
      catalog_version: 5,
      retention_class: "evidence_set",
      scan_origin: "generated",
      generation_document_id: generation,
      form_code: "tl407",
      form_version: "08-2025",
    });
  });

  it("refuses another participation's generation, a missing origin and back office", async () => {
    const id = await participation();
    const elsewhere = await generate(await participation());
    await expect(scan(id, "generated", elsewhere)).rejects.toMatchObject(
      failsWith("generation_not_found"),
    );
    await expect(scan(id, "generated", null)).rejects.toMatchObject(failsWith("invalid_argument"));
    await expect(scan(id, "external_paper", null, asBackOffice)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(scan(id, "external_paper", null, pl)).resolves.toEqual(expect.any(String));
  });
});

describe("review_document for a signed scan (Q184, Q185, Q193)", () => {
  it("records external paper signed before the platform as marked, with its registry version", async () => {
    const id = await participation();
    const documentId = await scan(id, "external_paper");
    await accept(documentId, {
      signedOn: "2019-05-02",
      countersignedOn: "2019-05-03",
      formVersion: "03-2019",
      declarations: { kind: "as_marked", jobboerseChoice: "none", baContactConsent: false },
    });
    expect(
      await one(
        `select review_state::text, form_code::text, form_version, signed_on::text,
           countersigned_on::text, review_confirmations from document where id = $1`,
        [documentId],
      ),
    ).toEqual({
      review_state: "accepted",
      form_code: "tl407",
      form_version: "03-2019",
      signed_on: "2019-05-02",
      countersigned_on: "2019-05-03",
      review_confirmations: both,
    });
    expect(await declarationsOf(documentId)).toEqual([
      {
        declaration: "baContactConsent",
        value: "no",
        form_code: "tl407",
        form_version: "03-2019",
        signed_on: "2019-05-03",
      },
      {
        declaration: "jobboerseChoice",
        value: "none",
        form_code: "tl407",
        form_version: "03-2019",
        signed_on: "2019-05-03",
      },
    ]);
    expect(
      await all(
        `select event_type::text, details from audit_event where participation_id = $1
           and event_type::text in ('document_reviewed', 'signed_declaration_recorded') order by seq`,
        [id],
      ),
    ).toEqual([
      {
        event_type: "signed_declaration_recorded",
        details: {
          documentId,
          formCode: "tl407",
          formVersion: "03-2019",
          declarations: ["jobboerseChoice", "baContactConsent"],
        },
      },
      {
        event_type: "document_reviewed",
        details: {
          documentId,
          documentType: "tl407_signed_scan",
          decision: "accepted",
          origin: "external_paper",
          formVersion: "03-2019",
        },
      },
    ]);
  });

  it("records the generation's snapshot as printed, whatever the pending values became", async () => {
    const id = await participation();
    const generation = await generate(id);
    // Changed after printing: the paper shows what was printed.
    await call(app, "write_profiling_declarations", {
      participationId: id,
      context: asConsultant,
      jobboerseChoice: "full",
      baContactConsent: false,
      revision: 1,
    });
    const documentId = await scan(id, "generated", generation);
    await accept(documentId);
    expect((await declarationsOf(documentId)).map((row) => row.value)).toEqual([
      "yes",
      "anonymous_callme",
    ]);
  });

  it("keeps the signed record under a concurrent edit of the pending declarations", async () => {
    const id = await participation();
    const documentId = await scan(id, "generated", await generate(id));
    const signedOn = await today();
    await app.query("begin");
    await call(app, "review_document", {
      context: asConsultant,
      documentId,
      decision: "accepted",
      reason: null,
      signedOn,
      countersignedOn: signedOn,
      confirmations: both,
      formVersion: null,
      declarations: JSON.stringify({ kind: "as_printed" }),
    });
    // The edit waits for the review's participation lock, then applies to the pending values only.
    const edit = call(other, "write_profiling_declarations", {
      participationId: id,
      context: asConsultant,
      jobboerseChoice: "none",
      baContactConsent: null,
      revision: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await app.query("commit");
    await edit;
    expect((await declarationsOf(documentId)).map((row) => row.value)).toEqual([
      "yes",
      "anonymous_callme",
    ]);
    expect(
      await one(
        "select jobboerse_choice::text, ba_contact_consent from participant_profiling where participation_id = $1",
        [id],
      ),
    ).toEqual({ jobboerse_choice: "none", ba_contact_consent: null });
  });

  it("refuses a date in the future, before the generation, missing confirmations or a wrong record", async () => {
    const id = await participation();
    const generated = await scan(id, "generated", await generate(id));
    const external = await scan(id, "external_paper");
    const tomorrow = (await one("select (berlin_today() + 1)::text as d")).d as string;
    await expect(accept(generated, { signedOn: tomorrow })).rejects.toMatchObject(
      failsWith("signature_in_future"),
    );
    await expect(accept(generated, { signedOn: await daysAgo(1) })).rejects.toMatchObject(
      failsWith("signature_before_generation"),
    );
    for (const bad of [
      { confirmations: ["signatures_present"] },
      { confirmations: null },
      { formVersion: "08-2025" },
      { declarations: { kind: "as_marked", jobboerseChoice: "everyone", baContactConsent: null } },
    ]) {
      await expect(accept(generated, bad)).rejects.toMatchObject(failsWith("invalid_argument"));
    }
    // External paper names its version and records what is marked, never "as printed".
    await expect(accept(external)).rejects.toMatchObject(failsWith("invalid_argument"));
    await expect(accept(external, { formVersion: "08-2025" })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await expect(
      call(app, "review_document", {
        context: asConsultant,
        documentId: external,
        decision: "rejected",
        reason: "incomplete",
        signedOn: await today(),
      }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
  });

  it("rejects without a record, once and final; the signed declaration is never rewritten", async () => {
    const id = await participation();
    const rejected = await scan(id, "external_paper");
    await call(app, "review_document", {
      context: pl,
      documentId: rejected,
      decision: "rejected",
      reason: "unreadable",
    });
    expect(await declarationsOf(rejected)).toEqual([]);
    const accepted = await scan(id, "external_paper");
    await accept(accepted, {
      formVersion: "08-2025",
      declarations: { kind: "as_marked", jobboerseChoice: "full", baContactConsent: true },
    });
    await expect(accept(accepted, { formVersion: "08-2025" })).rejects.toMatchObject(
      failsWith("document_reviewed"),
    );
    await expect(app.query("update signed_declaration set value = 'none'")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(app.query("delete from signed_declaration")).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe("delete_document for a signed scan (Q183)", () => {
  it("lets the PL delete before the review as wrong person or wrong file; the tombstone keeps the link", async () => {
    const id = await participation();
    const generation = await generate(id);
    const documentId = await scan(id, "generated", generation);
    const remove = (reason: string, context = pl) =>
      call(app, "delete_document", { context, documentId, reason });
    await expect(remove("duplicate")).rejects.toMatchObject(failsWith("delete_reason_not_allowed"));
    await expect(remove("wrong_person", asConsultant)).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await remove("wrong_person");
    expect(
      await one("select delete_reason::text, generation_document_id from document where id = $1", [
        documentId,
      ]),
    ).toEqual({ delete_reason: "wrong_person", generation_document_id: generation });
  });

  it("refuses an accepted scan (document_immutable)", async () => {
    const id = await participation();
    const documentId = await scan(id, "external_paper");
    await accept(documentId, {
      formVersion: "08-2025",
      declarations: { kind: "as_marked", jobboerseChoice: null, baContactConsent: null },
    });
    await expect(
      call(app, "delete_document", { context: pl, documentId, reason: "wrong_file" }),
    ).rejects.toMatchObject(failsWith("document_immutable"));
  });
});

/** A generated TL 407 signed and accepted today; the scan's id. */
async function signed(id: string) {
  const documentId = await scan(id, "generated", await generate(id));
  await accept(documentId, { signedOn: await today() });
  return documentId;
}

describe("quarantine, the TL 407 facts and profiling_done (Q183, Q191)", () => {
  it("gives tl407Signed and, after profiling_done, profilingDone recorded at the later instant", async () => {
    const id = await participation();
    await inProgress(id);
    expect(await facts(id)).toBeNull();
    const documentId = await signed(id);
    const signedOn = await today();
    const { reviewed_at } = await one("select reviewed_at from document where id = $1", [
      documentId,
    ]);
    expect(await facts(id)).toEqual({
      tl407_signed_on: signedOn,
      tl407_recorded_at: reviewed_at,
      profiling_done_on: null,
      profiling_done_recorded_at: null,
    });
    await expect(done(id, await daysAgo(1))).rejects.toMatchObject(
      failsWith("effective_date_before_signature"),
    );
    await done(id, signedOn);
    const changed = await one(
      `select occurred_at from audit_event where participation_id = $1
         and event_type = 'status_changed' and to_value = 'profiling_done'`,
      [id],
    );
    expect(await facts(id)).toMatchObject({
      profiling_done_on: signedOn,
      profiling_done_recorded_at: changed.occurred_at,
    });
  });

  it("quarantines at once: no review, no fact; the lift restores the fact", async () => {
    const id = await participation();
    await inProgress(id);
    const unreviewed = await scan(id, "external_paper");
    await call(app, "quarantine_document", {
      context: asConsultant,
      documentId: unreviewed,
      reason: "suspected_wrong_person",
    });
    await expect(
      accept(unreviewed, {
        formVersion: "08-2025",
        declarations: { kind: "as_marked", jobboerseChoice: null, baContactConsent: null },
      }),
    ).rejects.toMatchObject(failsWith("document_quarantined"));
    const documentId = await signed(id);
    await call(app, "quarantine_document", {
      context: asConsultant,
      documentId,
      reason: "suspected_wrong_acceptance",
    });
    await expect(
      call(app, "quarantine_document", {
        context: pl,
        documentId,
        reason: "suspected_wrong_person",
      }),
    ).rejects.toMatchObject(failsWith("document_quarantined"));
    // No fact: the status service's guard refuses `profiling_done` (apps/api, forms tests).
    expect(await facts(id)).toBeNull();
    await expect(
      call(app, "lift_document_quarantine", { context: asBackOffice, documentId }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await call(app, "lift_document_quarantine", { context: pl, documentId });
    await expect(
      call(app, "lift_document_quarantine", { context: pl, documentId }),
    ).rejects.toMatchObject(failsWith("document_not_quarantined"));
    // Recorded again from the lift (data-protection.md, quarantine).
    const { quarantine_lifted_at } = await one(
      "select quarantine_lifted_at from document where id = $1",
      [documentId],
    );
    expect((await facts(id)).tl407_recorded_at).toEqual(quarantine_lifted_at);
    await done(id, await today());
    expect(
      await all(
        `select event_type::text, reason_code from audit_event where participation_id = $1
           and event_type::text like 'document_quarantine%' order by seq`,
        [id],
      ),
    ).toEqual([
      { event_type: "document_quarantined", reason_code: "suspected_wrong_person" },
      { event_type: "document_quarantined", reason_code: "suspected_wrong_acceptance" },
      { event_type: "document_quarantine_lifted", reason_code: null },
    ]);
  });

  it("withholds profilingDone when no usable scan signed by its date remains; the date stays", async () => {
    const id = await participation();
    await inProgress(id);
    const external = (signedOn: string) =>
      scan(id, "external_paper").then(async (documentId) => {
        await accept(documentId, {
          signedOn,
          formVersion: "08-2025",
          declarations: { kind: "as_marked", jobboerseChoice: null, baContactConsent: null },
        });
        return documentId;
      });
    // Completed on the 10th on scan A; scan B, signed on the 5th after it, can't support that date.
    const first = await external(await daysAgo(10));
    await done(id, await daysAgo(10));
    const later = await external(await daysAgo(5));
    await call(app, "quarantine_document", {
      context: pl,
      documentId: first,
      reason: "suspected_wrong_person",
    });
    expect(await facts(id)).toMatchObject({
      tl407_signed_on: await daysAgo(5),
      profiling_done_on: null,
      profiling_done_recorded_at: null,
    });
    // The historical status and date stay for a controlled resolution; nothing moves them.
    expect(
      await one(
        "select profiling_status::text, profiling_done_on::text from participation where id = $1",
        [id],
      ),
    ).toEqual({ profiling_status: "profiling_done", profiling_done_on: await daysAgo(10) });
    // Supported again from the lift: recorded at the later of the change and the lift.
    await call(app, "lift_document_quarantine", { context: pl, documentId: first });
    const { quarantine_lifted_at } = await one(
      "select quarantine_lifted_at from document where id = $1",
      [first],
    );
    expect(await facts(id)).toMatchObject({
      profiling_done_on: await daysAgo(10),
      profiling_done_recorded_at: quarantine_lifted_at,
    });
    expect(later).toEqual(expect.any(String));
  });

  it("excludes invalidated evidence (data-protection.md, evidence corrections)", async () => {
    const id = await participation();
    const documentId = await signed(id);
    await owner.query("update document set invalidated_by_correction = $2 where id = $1", [
      documentId,
      randomUUID(),
    ]);
    expect(await facts(id)).toBeNull();
  });
});

describe("the scan's provenance survives the working copy (a retention-plan test)", () => {
  it("gives the working copy its accepted scan's instant; the links stay after the file is purged", async () => {
    const id = await participation();
    const generation = await generate(id);
    const documentId = await scan(id, "generated", generation);
    const signedOn = await today();
    await accept(documentId, { signedOn });
    const row = await one(
      `select g.generated_at, s.reviewed_at from form_generation g
         join document s on s.generation_document_id = g.document_id
       where g.document_id = $1 and s.review_state = 'accepted'`,
      [generation],
    );
    expect(
      workingCopyExpiry({
        generatedAt: new Date(row.generated_at),
        supersededAt: null,
        scanAcceptedAt: new Date(row.reviewed_at),
        closedAt: null,
        legalHold: false,
      }),
    ).toMatchObject({ kind: "due", trigger: "scan_accepted", afterDays: 30 });
    expect(retentionPeriods.form_working_copy).toBe("unset");
    // The retention job (Slice 7) deletes the working copy's file; its row stays a tombstone.
    await owner.query(
      `update document set deleted_at = now(), deleted_by = 'user', deleted_by_staff_user_id = $2,
         delete_reason = 'wrong_file', purged_at = now() where id = $1`,
      [generation, seedStaffUserIds.projectLead],
    );
    expect(
      await one(
        `select s.form_version, g.jobboerse_choice::text, g.ba_contact_consent, d.value
         from document s
         join form_generation g on g.document_id = s.generation_document_id
         join signed_declaration d on d.document_id = s.id and d.declaration = 'jobboerseChoice'
         where s.id = $1`,
        [documentId],
      ),
    ).toEqual({
      form_version: "08-2025",
      jobboerse_choice: "anonymous_callme",
      ba_contact_consent: true,
      value: "anonymous_callme",
    });
    expect(
      await all(
        `select confdeltype from pg_constraint where conname in
           ('document_generation_fk', 'signed_declaration_document_id_document_id_fk')`,
      ),
    ).toEqual([{ confdeltype: "a" }, { confdeltype: "a" }]);
  });
});
