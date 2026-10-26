import {
  FileNotFound,
  MemoryFileStorage,
  PdfLibRenderer,
  PdfUnavailable,
  pageCount,
} from "@transfer/adapters";
import { createDb, seedProjectIds, seedStaffUserIds } from "@transfer/db";
import {
  auditContext,
  call,
  changeStatus,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
} from "@transfer/db/testing";
import {
  DocumentOpening,
  ProfilingView,
  Tl407Generation,
  Tl407Readiness,
  type EducationRow,
} from "@transfer/domain";
import { loadFont } from "@transfer/forms/load";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fieldEncryptionKey } from "./field-encryption";
import { expectProblem, jsonRequest, login, readJson, testApp, testEnv } from "./testing";

// The TL 407 on the tab "Profiling" (data-protection.md, generated forms and the readiness
// projection; ba-forms.md, validation before rendering; Q179, Q196–Q198) against transfer_test,
// with memory storage and the mock HTML renderer: the readiness per viewer, the generation with
// its provenance and confirmations, and the generated document's opening. Synthetic data only:
// a participant of the `ta_only` project Verwaltung, assigned to the consultant.
const storage = new MemoryFileStorage();
const { app, db, logs } = testApp({ fileStorage: storage });
const owner = createDb(testDatabaseUrls().owner);
const { verwaltung } = seedProjectIds;
const { projectLead, consultant, backOffice } = seedStaffUserIds;
const staff = {} as Record<string, { Cookie: string }>;
const fieldKey = fieldEncryptionKey(testEnv.fieldEncryptionKey!);
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
/** Every response body of a test, to check that no value leaves where it mustn't. */
const answered: string[] = [];

beforeAll(async () => {
  await resetTestDatabase({ seed: true, active: true });
  for (const id of [projectLead, consultant, backOffice]) staff[id] = await login(app, id);
});
beforeEach(async () => {
  await resetTestDatabase({ seed: true, active: true });
  logs.length = 0;
  answered.length = 0;
  vi.restoreAllMocks();
});
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

async function request(method: string, path: string, as: string, body?: unknown) {
  const init = method === "GET" ? { headers: staff[as]! } : jsonRequest(method, body, staff[as]!);
  const res = await app.request(`/api/v1${path}`, init);
  answered.push(await res.clone().text());
  return res;
}
const readiness = (id: string, as: string = consultant) =>
  request("GET", `/participations/${id}/forms/tl407/readiness`, as);
const generate = (id: string, confirmWarnings: string[] = [], as: string = consultant) =>
  request("POST", `/participations/${id}/forms/tl407`, as, { confirmWarnings });

const sql = (text: string, values: unknown[] = []) => owner.$client.query(text, values);
const events = async (id: string, type: string) =>
  (
    await sql(
      "select reason_code, details from audit_event where participation_id = $1 and event_type = $2 order by seq",
      [id, type],
    )
  ).rows;

const school: EducationRow = {
  from: "1976-08-01",
  to: "1986-07-15",
  institution: "Gesamtschule Beispielstadt",
  qualification: "Mittlere Reife",
  completed: true,
};
const job = (n: number) => ({
  from: `2020-0${n}-01`,
  to: null,
  employer: `Lager ${n} GmbH`,
  activity: "Lagerist",
});

type Options = { education?: EducationRow[]; jobs?: number; lastName?: string; birthDate?: string };

/** A value sealed with the test key ($3) in the statement, as `write_sensitive_fields` would. */
const seal = (field: string, value: unknown) =>
  `public.seal_sensitive_value($1, '${field}', '${JSON.stringify(value)}'::jsonb, $3)`;

/**
 * A participant of Verwaltung with every applicable `*` field of the TL 407, assigned to the
 * consultant. The plain rows are written as fixtures; the sensitive answers sealed with the
 * test key as `write_sensitive_fields` would, the profiler's records through their functions.
 */
async function participant(options: Options = {}) {
  const id = await call(owner.$client, "create_participation", {
    projectId: verwaltung,
    context: pl,
  });
  await changeStatus(owner.$client, id, { field: "status", from: "imported", to: "contacted" });
  await changeStatus(owner.$client, id, { field: "status", from: "contacted", to: "informed" });
  await call(owner.$client, "assign_participations", {
    projectId: verwaltung,
    participationIds: [id],
    staffUserId: consultant,
    context: pl,
  });
  const keys = [id, verwaltung];
  await sql(
    `insert into participant_identity (participation_id, project_id, personnel_number, first_name,
       last_name, birth_date) values ($1, $2, $3, 'Erika', $4, $5)`,
    [
      ...keys,
      `P-${id.slice(0, 8)}`,
      options.lastName ?? "Beispiel",
      options.birthDate ?? "1970-01-01",
    ],
  );
  await sql(
    `insert into participant_details (participation_id, project_id, address_street,
       address_postal_code, address_city, address_country, mobile)
     values ($1, $2, 'Musterweg 1', '10115', 'Berlin', 'DE', '0171 3920000')`,
    keys,
  );
  await sql(
    `insert into participant_profile (participation_id, project_id, gender, marital_status,
       education_history, work_history, language_skills, driving_licence, vehicle_available,
       working_time_preferences, job_wishes, desired_work_locations, max_commute_distance,
       earliest_start_date, revision)
     values ($1, $2, 'female', 'single', $3, $4, $5, '{B}', true, $6, $7, 'Berlin', $8,
       '2026-12-01', 1)`,
    [
      ...keys,
      JSON.stringify(options.education ?? [{ ...school, highestSchoolQualification: true }]),
      JSON.stringify(Array.from({ length: options.jobs ?? 1 }, (_, n) => job(n + 1))),
      JSON.stringify({ german: "business_fluent", others: [] }),
      JSON.stringify({
        employmentType: "full_time",
        weeklyHours: null,
        distribution: "Frühschicht",
      }),
      JSON.stringify({ desired: "Lagerist", alternative: null }),
      JSON.stringify({ kind: "km", km: 30 }),
    ],
  );
  await sql(
    `insert into participant_identifier_data (participation_id, project_id,
       pension_insurance_number, pension_insurance_number_present, key_id)
     values ($1, $2, ${seal("pensionInsuranceNumber", "12290751D123")}, true, $4)`,
    [...keys, fieldKey.key, fieldKey.keyId],
  );
  await sql(
    `insert into participant_residence_social_data (participation_id, project_id, nationality,
       nationality_present, buergergeld, buergergeld_present, key_id)
     values ($1, $2, ${seal("nationality", { kind: "german" })}, true,
       ${seal("buergergeld", false)}, true, $4)`,
    [...keys, fieldKey.key, fieldKey.keyId],
  );
  await sql(
    `insert into participant_health_data (participation_id, project_id, health_restrictions,
       health_restrictions_present, severe_disability, severe_disability_present, key_id)
     values ($1, $2, ${seal("healthRestrictions", false)}, true, ${seal("severeDisability", false)},
       true, $4)`,
    [...keys, fieldKey.key, fieldKey.keyId],
  );
  await call(owner.$client, "write_unemployment_period", {
    participationId: id,
    context: asConsultant,
    period: JSON.stringify({ from: "2026-07-01", until: null }),
    revision: 0,
    key: fieldKey.key,
    keyId: fieldKey.keyId,
  });
  await call(owner.$client, "write_profiling_declarations", {
    participationId: id,
    context: asConsultant,
    jobboerseChoice: "full",
    baContactConsent: false,
    revision: 0,
  });
  return id;
}

const read = async (id: string, as: string = consultant) => {
  const res = await readiness(id, as);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return readJson(res, Tl407Readiness);
};
const codesOf = async (res: Response, status = 422) =>
  (await expectProblem(res, status, status === 409 ? "conflict" : "domain-error")).errors?.map(
    ({ code, pointer }) => ({ code, pointer }),
  );

describe("the readiness projection (data-protection.md)", () => {
  it("gives the profiler every code, warning and overflow, each decryption audited", async () => {
    const id = await participant({ education: [school], jobs: 8 });
    await call(owner.$client, "write_unemployment_period", {
      participationId: id,
      context: asConsultant,
      period: JSON.stringify({ from: "2026-07-01", until: "2026-01-31" }),
      revision: 1,
      key: fieldKey.key,
      keyId: fieldKey.keyId,
    });
    expect(await read(id)).toEqual({
      view: "profiler",
      formVersion: "08-2025",
      ready: true,
      errors: [],
      warnings: [
        {
          code: "range_reversed",
          key: "unemployedUntil",
          label: expect.stringContaining("Arbeitslosigkeit endet am"),
        },
        {
          code: "school_qualification_none",
          key: "education",
          label: expect.stringContaining("39"),
        },
      ],
      overflow: [{ kind: "table", key: "work", label: expect.stringContaining("40") }],
    });
    const reads = (await events(id, "sensitive_read")).map((row) => row.details.key);
    expect(reads.toSorted()).toEqual(
      [
        "buergergeld",
        "healthRestrictions",
        "nationality",
        "pensionInsuranceNumber",
        "severeDisability",
        "unemploymentPeriod",
      ].toSorted(),
    );
  });

  it("explains an unsupported character by field, for the external-paper path (Q197)", async () => {
    const id = await participant({ lastName: "Иванова" });
    const result = await read(id);
    expect(result).toMatchObject({
      view: "profiler",
      ready: false,
      errors: [{ code: "character_unsupported", key: "lastName", label: "7 Nachname" }],
      overflow: [],
    });
    expect(await codesOf(await generate(id))).toEqual([
      { code: "character_unsupported", pointer: "" },
    ]);
  });

  it("gives the PL ready or not and the missing known fields: no warning, no overflow, no decryption", async () => {
    // The profiler's readiness has a warning and the overflow…
    const id = await participant({ education: [school], jobs: 8 });
    expect(await read(id)).toMatchObject({
      view: "profiler",
      warnings: [{ code: "school_qualification_none" }],
      overflow: [{ kind: "table", key: "work" }],
    });
    const decrypted = (await events(id, "sensitive_read")).length;
    // …the PL's has neither, and nothing was decrypted for it.
    const lead = await read(id, projectLead);
    expect(lead).toEqual({ view: "project_lead", ready: true, missing: [] });
    expect(Object.keys(lead).toSorted()).toEqual(["missing", "ready", "view"]);
    expect(await events(id, "sensitive_read")).toHaveLength(decrypted);
    await sql("update participant_identity set birth_date = null where participation_id = $1", [
      id,
    ]);
    await sql(
      `update participant_identifier_data set pension_insurance_number = null,
         pension_insurance_number_present = false where participation_id = $1`,
      [id],
    );
    expect(await read(id, projectLead)).toEqual({
      view: "project_lead",
      ready: false,
      // Neither the RV-Nummer (identifiers) nor the unemployment period is the PL's to know.
      missing: [{ key: "birthDate", label: "8 Geburtsdatum" }],
    });
    for (const body of answered.filter((text) => text.includes('"project_lead"'))) {
      for (const hidden of ["warnings", "overflow", "school_qualification", "unemploy", "errors"]) {
        expect(body).not.toContain(hidden);
      }
    }
  });

  it("is ready for the PL when nothing they may know about is missing", async () => {
    const id = await participant();
    await sql(
      `update participant_residence_social_data set unemployment_period = null,
         unemployment_period_present = false where participation_id = $1`,
      [id],
    );
    expect(await read(id, projectLead)).toEqual({ view: "project_lead", ready: true, missing: [] });
    expect(await read(id)).toMatchObject({
      ready: false,
      errors: [{ code: "required_missing", key: "unemployedFrom" }],
    });
  });

  it("is 404 for an unassigned consultant and 403 for back office", async () => {
    const id = await participant();
    await expectProblem(await readiness(id, backOffice), 403, "forbidden");
    await call(owner.$client, "unassign_participation", {
      participationId: id,
      staffUserId: consultant,
      context: pl,
    });
    await expectProblem(await readiness(id), 404, "not-found");
  });
});

describe("generation (data-protection.md, generated forms; Q179)", () => {
  it("stores the packet with its provenance and declaration snapshot, each confirmation audited", async () => {
    const id = await participant({ education: [school], jobs: 8 });
    expect(await codesOf(await generate(id))).toEqual([
      { code: "school_qualification_none", pointer: "/confirmWarnings" },
    ]);
    const res = await generate(id, ["school_qualification_none", "age_implausible"]);
    expect(res.status).toBe(201);
    const generated = await readJson(res, Tl407Generation);
    expect(generated).toEqual({
      documentId: expect.any(String),
      formVersion: "08-2025",
      anlage: true,
    });
    const [provenance] = (
      await sql(
        `select form_code::text, form_version, profile_revision, profiling_revision,
           assessment_revision, unemployment_revision, jobboerse_choice::text, ba_contact_consent,
           confirmed_warnings, anlage, generated_by
         from form_generation where document_id = $1`,
        [generated.documentId],
      )
    ).rows;
    expect(provenance).toEqual({
      form_code: "tl407",
      form_version: "08-2025",
      profile_revision: 1,
      profiling_revision: 1,
      assessment_revision: 0,
      unemployment_revision: 1,
      jobboerse_choice: "full",
      ba_contact_consent: false,
      // only what the check asked for: the age is plausible
      confirmed_warnings: ["school_qualification_none"],
      anlage: true,
      generated_by: consultant,
    });
    expect((await events(id, "form_generated")).map((row) => row.details)).toEqual([
      { documentId: generated.documentId, formCode: "tl407", formVersion: "08-2025", anlage: true },
    ]);
    expect((await events(id, "warning_confirmed")).map((row) => row.reason_code)).toEqual([
      "school_qualification_none",
    ]);
    // Stored encrypted: the object isn't a PDF.
    const object = await storage.get(`documents/${generated.documentId}`);
    expect(Buffer.from(object.subarray(0, 4)).toString()).not.toBe("%PDF");
    const outcomes = logs
      .filter((text) => text.includes('"form generation"'))
      .map((text) => (JSON.parse(text) as { outcome: string }).outcome);
    expect(outcomes).toEqual(["refused", "generated"]);
    for (const value of ["Beispiel", "12290751D123", "Musterweg", "Lagerist"]) {
      expect(logs.join("\n")).not.toContain(value);
    }
  });

  it("opens only through the logged opening, for the profiler and the PL, as tl407-<date>.pdf", async () => {
    const id = await participant({ jobs: 8 });
    const { documentId } = await readJson(await generate(id), Tl407Generation);
    for (const as of [consultant, projectLead]) {
      const opened = await request(
        "POST",
        `/participations/${id}/documents/${documentId}/opening`,
        as,
        {},
      );
      expect(opened.status).toBe(201);
      const { url } = await readJson(opened, DocumentOpening);
      const file = await app.request(url, { headers: staff[as]! });
      expect(file.status).toBe(200);
      expect(file.headers.get("content-disposition")).toMatch(
        /filename="tl407-\d{4}-\d{2}-\d{2}\.pdf"/,
      );
      const pdf = new Uint8Array(await file.arrayBuffer());
      // The TL 407's seven pages and the Anlage.
      expect(await pageCount(pdf)).toBeGreaterThan(7);
    }
    expect(await events(id, "document_opened")).toHaveLength(2);
    await expectProblem(
      await request(
        "DELETE",
        `/participations/${id}/documents/${documentId}?reasonCode=wrong_file`,
        projectLead,
      ),
      403,
      "forbidden",
    );
  });

  it("lists the generated forms on the tab, latest first, for the PL and the profiler", async () => {
    const id = await participant();
    const first = await readJson(await generate(id), Tl407Generation);
    const second = await readJson(await generate(id), Tl407Generation);
    for (const as of [consultant, projectLead]) {
      const res = await request("GET", `/participations/${id}/profiling`, as);
      const view = await readJson(res, ProfilingView);
      expect(
        view.tl407Forms.map(({ documentId, latest, versionInUse, anlage, capabilities }) => ({
          documentId,
          latest,
          versionInUse,
          anlage,
          capabilities,
        })),
      ).toEqual([
        {
          documentId: second.documentId,
          latest: true,
          versionInUse: true,
          anlage: false,
          capabilities: { open: true },
        },
        {
          documentId: first.documentId,
          latest: false,
          versionInUse: true,
          anlage: false,
          capabilities: { open: true },
        },
      ]);
      expect(view.capabilities).toMatchObject({
        generateTl407: as === consultant,
        readTl407Readiness: true,
      });
    }
  });

  it("ties the 'no school qualification' answer to the source values it was given for (Q198)", async () => {
    const id = await participant({ education: [school] });
    expect((await generate(id, ["school_qualification_none"])).status).toBe(201);
    // The participant edits the education afterwards: the earlier answer isn't inherited.
    await sql(
      `update participant_profile set education_history = $2, revision = revision + 1
       where participation_id = $1`,
      [id, JSON.stringify([school, { ...school, institution: "Abendschule" }])],
    );
    expect(await codesOf(await generate(id))).toEqual([
      { code: "school_qualification_none", pointer: "/confirmWarnings" },
    ]);
    // A designated row needs no answer; no row is made up and none is inferred.
    await sql("update participant_profile set education_history = $2 where participation_id = $1", [
      id,
      JSON.stringify([{ ...school, highestSchoolQualification: true }]),
    ]);
    expect((await generate(id)).status).toBe(201);
  });

  it("refuses when a source moves between its read and its record, and deletes the object", async () => {
    const id = await participant();
    const put = storage.put.bind(storage);
    vi.spyOn(storage, "put").mockImplementation(async (key, content) => {
      await call(owner.$client, "write_profiling_declarations", {
        participationId: id,
        context: asConsultant,
        jobboerseChoice: "none",
        baContactConsent: false,
        revision: 1,
      });
      return put(key, content);
    });
    expect(await codesOf(await generate(id), 409)).toEqual([
      { code: "source_changed", pointer: "" },
    ]);
    const stored = vi.mocked(storage.put).mock.calls[0]![0];
    await expect(storage.get(stored)).rejects.toBeInstanceOf(FileNotFound);
    expect((await sql("select count(*)::int as n from form_generation")).rows).toEqual([{ n: 0 }]);
  });

  it("is the assigned consultant's only, while the participation is open", async () => {
    const id = await participant();
    for (const as of [projectLead, backOffice]) {
      await expectProblem(await generate(id, [], as), 403, "forbidden");
    }
    await changeStatus(owner.$client, id, {
      field: "status",
      from: "informed",
      to: "withdrawn",
      endReason: "other",
      effectiveDate: "2026-02-01",
    });
    expect(await codesOf(await generate(id))).toEqual([
      { code: "participation_closed", pointer: "" },
    ]);
  });

  it("answers 503 pdf_unavailable when the Anlage can't be rendered", async () => {
    const font = loadFont();
    const renderer = new PdfLibRenderer(font);
    vi.spyOn(renderer, "renderHtml").mockRejectedValue(new PdfUnavailable());
    const { app: withoutHtml, db: second } = testApp({
      fileStorage: storage,
      pdfRenderer: renderer,
    });
    const id = await participant({ jobs: 8 });
    const res = await withoutHtml.request(
      `/api/v1/participations/${id}/forms/tl407`,
      jsonRequest("POST", { confirmWarnings: [] }, await login(withoutHtml, consultant)),
    );
    const problem = await expectProblem(res, 503, "service-unavailable");
    expect(problem.errors?.[0]?.code).toBe("pdf_unavailable");
    expect((await sql("select count(*)::int as n from form_generation")).rows).toEqual([{ n: 0 }]);
    await second.$client.end();
  });
});
