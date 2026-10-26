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
} from "./testing";

// A generated form's record (data-protection.md, generated forms; Q179) as transfer_app calls
// `record_form_generation`: the document and its provenance, the confirmed warnings, the source
// revisions checked under the participation lock, and the working copy's immutability. Synthetic
// values only; the file itself is the API's (it never reaches the database).
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app });
const owner = new Client({ connectionString: urls.owner });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const { consultant, backOffice } = seedStaffUserIds;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const asBackOffice = auditContext({ actorType: "user", staffUserId: backOffice });
const { werkNord } = seedProjectIds;

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;

/** An informed participation of Werk Nord, assigned to the consultant. */
async function participation() {
  const id = await call(app, "create_participation", { projectId: werkNord, context: pl });
  await changeStatus(app, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(app, id, { field: "status", from: "contacted", to: "informed" });
  await call(app, "assign_participations", {
    projectId: werkNord,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  return id;
}

const sources = { profile: 0, profiling: 0, assessment: 0, unemployment: 0 };
const declarations = { jobboerseChoice: null, baContactConsent: null };

function generate(
  participationId: string,
  overrides: Record<string, unknown> = {},
  context = asConsultant,
) {
  return call(app, "record_form_generation", {
    context,
    participationId,
    generationId: randomUUID(),
    documentId: randomUUID(),
    formCode: "tl407",
    formVersion: "08-2025",
    sources: JSON.stringify(sources),
    declarations: JSON.stringify(declarations),
    confirmedWarnings: [],
    anlage: false,
    sizeBytes: 2048,
    contentSha256: createHash("sha256").update("synthetic").digest("hex"),
    keyId: hex(8),
    wrappedKey: randomBytes(60),
    ...overrides,
  });
}

describe("record_form_generation (Q179)", () => {
  it("stores the document and its provenance, audited with each confirmed warning", async () => {
    const id = await participation();
    await call(app, "write_profiling_declarations", {
      participationId: id,
      context: asConsultant,
      jobboerseChoice: "anonymous_callme",
      baContactConsent: true,
      revision: 0,
    });
    const documentId = randomUUID();
    const generationId = await generate(id, {
      documentId,
      sources: JSON.stringify({ ...sources, profiling: 1 }),
      declarations: JSON.stringify({ jobboerseChoice: "anonymous_callme", baContactConsent: true }),
      confirmedWarnings: ["age_implausible", "school_qualification_none"],
      anlage: true,
    });
    expect(
      await one(
        `select type::text, catalog_version, retention_class, media_type::text, file_name,
           added_by::text, added_by_staff_user_id, review_state::text
         from document where id = $1`,
        [documentId],
      ),
    ).toEqual({
      type: "tl407_form",
      catalog_version: 3,
      retention_class: "form_working_copy",
      media_type: "application/pdf",
      file_name: null,
      added_by: "user",
      added_by_staff_user_id: consultant,
      review_state: "unreviewed",
    });
    expect(
      await one(
        `select document_id, form_code::text, form_version, profile_revision, profiling_revision,
           assessment_revision, unemployment_revision, jobboerse_choice::text, ba_contact_consent,
           confirmed_warnings, anlage, generated_by
         from form_generation where id = $1`,
        [generationId],
      ),
    ).toEqual({
      document_id: documentId,
      form_code: "tl407",
      form_version: "08-2025",
      profile_revision: 0,
      profiling_revision: 1,
      assessment_revision: 0,
      unemployment_revision: 0,
      jobboerse_choice: "anonymous_callme",
      ba_contact_consent: true,
      confirmed_warnings: ["age_implausible", "school_qualification_none"],
      anlage: true,
      generated_by: consultant,
    });
    const audited = await all(
      `select event_type::text, reason_code, details, actor_staff_user_id from audit_event
       where participation_id = $1 and event_type::text in ('form_generated', 'warning_confirmed')
       order by seq`,
      [id],
    );
    expect(audited).toEqual([
      {
        event_type: "form_generated",
        reason_code: null,
        details: { documentId, formCode: "tl407", formVersion: "08-2025", anlage: true },
        actor_staff_user_id: consultant,
      },
      ...["age_implausible", "school_qualification_none"].map((code) => ({
        event_type: "warning_confirmed",
        reason_code: code,
        details: {},
        actor_staff_user_id: consultant,
      })),
    ]);
  });

  it("refuses when a source moved since the read or the printed declarations aren't pending", async () => {
    const id = await participation();
    for (const moved of [
      { ...sources, profile: 1 },
      { ...sources, profiling: 1 },
      { ...sources, assessment: 1 },
      { ...sources, unemployment: 1 },
    ]) {
      await expect(generate(id, { sources: JSON.stringify(moved) })).rejects.toMatchObject(
        failsWith("source_changed"),
      );
    }
    const printed = { jobboerseChoice: "full", baContactConsent: null };
    await expect(generate(id, { declarations: JSON.stringify(printed) })).rejects.toMatchObject(
      failsWith("source_changed"),
    );
    expect(await all("select id from form_generation")).toEqual([]);
    expect(await all("select id from document where type = 'tl407_form'")).toEqual([]);
  });

  it("lets only the assigned consultant generate, as themselves, while the participation is open", async () => {
    const id = await participation();
    const assisted = auditContext({ actorType: "user", staffUserId: consultant, onBehalfOf: id });
    for (const context of [pl, asBackOffice, assisted]) {
      await expect(generate(id, {}, context)).rejects.toMatchObject(failsWith("actor_not_allowed"));
    }
    const closed = await participation();
    await changeStatus(app, closed, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: "2026-02-01",
    });
    await expect(generate(closed)).rejects.toMatchObject(failsWith("participation_closed"));
  });

  it("refuses another form, a malformed provenance and an unknown or repeated warning", async () => {
    const id = await participation();
    await expect(generate(id, { formCode: "kug200b" })).rejects.toMatchObject(
      failsWith("form_not_supported"),
    );
    for (const bad of [
      { formVersion: "08/2025" },
      { sources: JSON.stringify({ ...sources, profile: -1 }) },
      { sources: JSON.stringify({ profile: 0 }) },
      { declarations: JSON.stringify({ jobboerseChoice: "everyone", baContactConsent: null }) },
      { declarations: JSON.stringify({ jobboerseChoice: null, baContactConsent: "yes" }) },
      { confirmedWarnings: ["looks_odd"] },
      { confirmedWarnings: ["range_reversed", "range_reversed"] },
      { wrappedKey: randomBytes(12) },
    ]) {
      await expect(generate(id, bad)).rejects.toMatchObject(failsWith("invalid_argument"));
    }
  });
});

/** A working copy's facts, as the retention job will read them. */
const facts = (generatedAt: Date, supersededAt: Date | null) => ({
  generatedAt,
  supersededAt,
  scanAcceptedAt: null,
  closedAt: null,
  legalHold: false,
});

describe("the generated form is a working copy (data-protection.md, generated forms)", () => {
  it("is never uploaded, reviewed or deleted by an ordinary operation", async () => {
    const id = await participation();
    const documentId = randomUUID();
    await generate(id, { documentId });
    await expect(
      call(app, "delete_document", { context: pl, documentId, reason: "wrong_file" }),
    ).rejects.toMatchObject(failsWith("document_immutable"));
    await expect(
      call(app, "review_document", {
        context: asConsultant,
        documentId,
        decision: "accepted",
        reason: null,
      }),
    ).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await expect(
      call(app, "add_document", {
        context: asConsultant,
        participationId: id,
        id: randomUUID(),
        type: "tl407_form",
        mediaType: "application/pdf",
        sizeBytes: 10,
        contentSha256: hex(),
        fileName: null,
        keyId: hex(8),
        wrappedKey: randomBytes(60),
      }),
    ).rejects.toMatchObject(failsWith("document_type_not_supported"));
  });

  it("has a cleanup path while its periods stay unset (a retention-plan test)", async () => {
    const id = await participation();
    const first = await generate(id);
    await generate(id);
    const rows = await all(
      `select id, generated_at from form_generation where participation_id = $1
       order by generated_at, id`,
      [id],
    );
    // The retention job (Slice 7) reads these facts: the first is superseded by the second, the
    // sole latest one is abandoned 90 days after its generation unless a scan follows.
    const superseded = rows.find((row) => row.id === first)!;
    const latest = rows.find((row) => row.id !== first)!;
    expect(workingCopyExpiry(facts(superseded.generated_at, latest.generated_at))).toMatchObject({
      kind: "due",
      trigger: "superseded",
      afterDays: 30,
    });
    expect(workingCopyExpiry(facts(latest.generated_at, null))).toMatchObject({
      kind: "due",
      trigger: "abandoned",
      afterDays: 90,
    });
    // No job may delete before the DPO confirms the periods (ADR-0008).
    expect(retentionPeriods.form_working_copy).toBe("unset");
    // The provenance doesn't depend on the file: it stays as the tombstone.
    expect(
      await all(
        `select confdeltype from pg_constraint where conname = 'form_generation_document_id_document_id_fk'`,
      ),
    ).toEqual([{ confdeltype: "a" }]);
  });

  it("is selectable by transfer_app without a ciphertext, and never written by it", async () => {
    const id = await participation();
    await generate(id);
    const { rows } = await app.query("select form_version, anlage from form_generation");
    expect(rows).toEqual([{ form_version: "08-2025", anlage: false }]);
    await expect(app.query("update form_generation set anlage = true")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(app.query("delete from form_generation")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(app.query("select wrapped_key from document")).rejects.toMatchObject({
      code: "42501",
    });
  });
});
