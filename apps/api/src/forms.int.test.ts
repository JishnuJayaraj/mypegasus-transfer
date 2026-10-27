import {
  FileNotFound,
  MemoryFileStorage,
  PdfLibRenderer,
  PdfUnavailable,
  pageCount,
  scheduledAt,
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
  canTransition,
  DocumentOpening,
  DocumentView,
  ProfilingView,
  Tl407Generation,
  Tl407Readiness,
  type EducationRow,
  type TgEntryKind,
} from "@transfer/domain";
import { loadFont } from "@transfer/forms/load";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fieldEncryptionKey } from "./field-encryption";
import { dbGuardFacts } from "./participations/guard-facts";
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
/** The source token of the profiler's readiness now (a logged read). */
async function tokenOf(id: string) {
  const checked = (await (await readiness(id)).json()) as { sourceToken: string };
  return checked.sourceToken;
}
/** A generation for the readiness checked just before, unless a token is given. */
const generate = async (
  id: string,
  confirmWarnings: string[] = [],
  as: string = consultant,
  sourceToken?: string,
) =>
  request("POST", `/participations/${id}/forms/tl407`, as, {
    sourceToken: sourceToken ?? (await tokenOf(id)),
    confirmWarnings,
  });

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

type Options = {
  education?: EducationRow[] | null;
  jobs?: number;
  lastName?: string;
  birthDate?: string;
};

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
      options.education === null
        ? null
        : JSON.stringify(options.education ?? [{ ...school, highestSchoolQualification: true }]),
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
      sourceToken: expect.stringMatching(/^[0-9a-f]{64}$/),
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
    expect(
      await codesOf(
        await request(
          "DELETE",
          `/participations/${id}/documents/${documentId}?reasonCode=wrong_file`,
          projectLead,
        ),
      ),
    ).toEqual([{ code: "document_immutable", pointer: "" }]);
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

  it("applies a confirmation only to the sources its readiness showed (Q199)", async () => {
    const id = await participant({ education: [school] });
    const checked = await read(id);
    expect(checked).toMatchObject({ warnings: [{ code: "school_qualification_none" }] });
    const { sourceToken } = checked as { sourceToken: string };
    // The education changes after the check: the old "Kein Schulabschluss" mustn't apply to it.
    await sql(
      `update participant_profile set education_history = $2, revision = revision + 1
       where participation_id = $1`,
      [id, JSON.stringify([{ ...school, institution: "Abendschule" }])],
    );
    expect(
      await codesOf(
        await generate(id, ["school_qualification_none"], consultant, sourceToken),
        409,
      ),
    ).toEqual([{ code: "source_changed", pointer: "/sourceToken" }]);
    expect(await events(id, "warning_confirmed")).toEqual([]);
    expect((await sql("select count(*)::int as n from form_generation")).rows).toEqual([{ n: 0 }]);
  });

  it("takes a reviewed 'Kein Schulabschluss' without any education row, never a made-up one (Q199)", async () => {
    const id = await participant({ education: null });
    expect(await read(id)).toMatchObject({
      ready: true,
      errors: [],
      warnings: [{ code: "school_qualification_none", key: "education" }],
    });
    // Not clarified: refused; answered: generated with the table blank.
    expect(await codesOf(await generate(id))).toEqual([
      { code: "school_qualification_none", pointer: "/confirmWarnings" },
    ]);
    expect((await generate(id, ["school_qualification_none"])).status).toBe(201);
    expect(
      (
        await sql("select confirmed_warnings from form_generation where participation_id = $1", [
          id,
        ])
      ).rows,
    ).toEqual([{ confirmed_warnings: ["school_qualification_none"] }]);
  });

  it("refuses a form printed with a name corrected meanwhile (identity has no revision)", async () => {
    const id = await participant();
    const put = storage.put.bind(storage);
    vi.spyOn(storage, "put").mockImplementation(async (key, content) => {
      await call(owner.$client, "write_participant_data", {
        participationId: id,
        context: pl,
        lastName: "Beispiel-Neu",
      });
      return put(key, content);
    });
    expect(await codesOf(await generate(id), 409)).toEqual([
      { code: "source_changed", pointer: "/sourceToken" },
    ]);
    expect((await sql("select count(*)::int as n from form_generation")).rows).toEqual([{ n: 0 }]);
    // The token covers the identity, the contact details and the TG dates as well.
    vi.restoreAllMocks();
    const before = await tokenOf(id);
    await sql(
      "update participant_details set mobile = '0171 1111111' where participation_id = $1",
      [id],
    );
    expect(await tokenOf(id)).not.toBe(before);
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
      { code: "source_changed", pointer: "/sourceToken" },
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
      jsonRequest(
        "POST",
        { sourceToken: await tokenOf(id), confirmWarnings: [] },
        await login(withoutHtml, consultant),
      ),
    );
    const problem = await expectProblem(res, 503, "service-unavailable");
    expect(problem.errors?.[0]?.code).toBe("pdf_unavailable");
    expect((await sql("select count(*)::int as n from form_generation")).rows).toEqual([{ n: 0 }]);
    await second.$client.end();
  });
});

// The signed TL 407 (data-protection.md, signed scans, signed declarations and quarantine;
// process-and-lifecycle.md, profiling track; Q183–Q185, Q191, Q193).
const scanPdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Title (synthetic scan) >>\nendobj\n%%EOF\n");
const both = ["signatures_present", "all_pages_present"];
const berlinDay = async (offset = 0) =>
  (await sql("select (berlin_today() + $1::int)::text as d", [offset])).rows[0].d as string;

/** Uploads a signed scan; its id. */
async function upload(id: string, origin: object, as: string = consultant) {
  return request("POST", `/participations/${id}/documents`, as, {
    type: "tl407_signed_scan",
    fileName: "scan.pdf",
    content: scanPdf.toString("base64"),
    ...origin,
  });
}
async function uploaded(id: string, origin: object, as: string = consultant) {
  const res = await upload(id, origin, as);
  expect(res.status).toBe(201);
  return (await readJson(res, DocumentView)).id;
}
const review = (id: string, documentId: string, body: object, as: string = consultant) =>
  request("POST", `/participations/${id}/documents/${documentId}/review`, as, body);
async function accept(id: string, documentId: string, scan: object, as: string = consultant) {
  const today = await berlinDay();
  const res = await review(
    id,
    documentId,
    {
      decision: "accepted",
      scan: {
        participantSignedOn: today,
        profilerSignedOn: today,
        confirmations: both,
        declarations: { kind: "as_printed" },
        ...scan,
      },
    },
    as,
  );
  expect(res.status).toBe(200);
  return res;
}
const profiling = async (id: string, as: string = consultant) =>
  readJson(await request("GET", `/participations/${id}/profiling`, as), ProfilingView);
async function inProgress(id: string) {
  for (const [from, to] of [
    ["not_started", "profiling_accepted"],
    ["profiling_accepted", "profiling_in_progress"],
  ] as const) {
    await changeStatus(owner.$client, id, { field: "profiling_status", from, to });
  }
}
const complete = async (id: string, effectiveDate: string, as: string = consultant) =>
  request("POST", `/participations/${id}/profiling-status`, as, {
    to: "profiling_done",
    effectiveDate,
    statusVersion: (await profiling(id, as)).statusVersion,
  });

describe("signed scans and their origin (Q184, Q197)", () => {
  it("takes a scan printed from a generation of the same participation, or external paper", async () => {
    const id = await participant();
    const { documentId: generation } = await readJson(await generate(id), Tl407Generation);
    const scan = await uploaded(id, { origin: "generated", generationDocumentId: generation });
    await uploaded(id, { origin: "external_paper" }, projectLead);
    const view = await profiling(id);
    expect(
      view.tl407Scans.map(({ documentId, origin, generationDocumentId, formVersion }) => ({
        documentId,
        origin,
        generationDocumentId,
        formVersion,
      })),
    ).toEqual([
      {
        documentId: scan,
        origin: "generated",
        generationDocumentId: generation,
        formVersion: "08-2025",
      },
      {
        documentId: expect.any(String),
        origin: "external_paper",
        generationDocumentId: null,
        formVersion: null,
      },
    ]);
    expect(view.capabilities.addTl407Scan).toBe(true);
    expect(view.tl407Versions).toEqual(["08-2025"]);
    expect(await codesOf(await upload(id, {}))).toEqual([
      { code: "origin_required", pointer: "/origin" },
    ]);
    const elsewhere = await participant();
    const other = await readJson(await generate(elsewhere), Tl407Generation);
    expect(
      await codesOf(
        await upload(id, { origin: "generated", generationDocumentId: other.documentId }),
      ),
    ).toEqual([{ code: "generation_not_found", pointer: "/generationDocumentId" }]);
    await expectProblem(
      await upload(id, { origin: "external_paper" }, backOffice),
      403,
      "forbidden",
    );
  });

  it("records external paper signed before the platform's generation without re-signing", async () => {
    const id = await participant();
    await inProgress(id);
    // The platform generates later; the paper the participant signed earlier stays valid.
    await generate(id);
    const documentId = await uploaded(id, { origin: "external_paper" });
    const signedOn = await berlinDay(-30);
    expect(
      await codesOf(
        await review(id, documentId, {
          decision: "accepted",
          scan: {
            participantSignedOn: signedOn,
            profilerSignedOn: signedOn,
            confirmations: both,
            formVersion: "01-2001",
            declarations: { kind: "as_printed" },
          },
        }),
      ),
    ).toEqual([
      { code: "form_version_unknown", pointer: "/scan/formVersion" },
      { code: "declarations_as_marked_required", pointer: "/scan/declarations" },
    ]);
    await accept(id, documentId, {
      participantSignedOn: await berlinDay(-31),
      profilerSignedOn: signedOn,
      formVersion: "08-2025",
      declarations: { kind: "as_marked", jobboerseChoice: "none", baContactConsent: null },
    });
    const view = await profiling(id);
    expect(view.tl407SignedOn).toBe(signedOn);
    expect(view.signedDeclarations).toEqual({
      documentId,
      formVersion: "08-2025",
      signedOn,
      acceptedAt: expect.any(String),
      jobboerseChoice: "none",
      baContactConsent: null,
    });
    expect(view.transitions).toContainEqual({ to: "profiling_done", allowed: true, refusal: null });
    // profilingDoneOn: the later signature date at the earliest, never in the future (Q191).
    expect(await codesOf(await complete(id, await berlinDay(-31)))).toEqual([
      { code: "effective_date_before_signature", pointer: "" },
    ]);
    expect((await complete(id, signedOn)).status).toBe(200);
    expect((await profiling(id)).profilingDoneOn).toBe(signedOn);
    expect((await events(id, "document_reviewed")).map((row) => row.details)).toEqual([
      {
        documentId,
        documentType: "tl407_signed_scan",
        decision: "accepted",
        origin: "external_paper",
        formVersion: "08-2025",
      },
    ]);
  });

  it("keeps the signed record when a declaration changes after printing, also during the review", async () => {
    const id = await participant();
    const { documentId: generation } = await readJson(await generate(id), Tl407Generation);
    const write = async (jobboerseChoice: string, baContactConsent: boolean | null) =>
      request("PUT", `/participations/${id}/profiling/declarations`, consultant, {
        jobboerseChoice,
        baContactConsent,
        revision: (await profiling(id)).revision,
      });
    // Printed `full` / no contact; changed afterwards, before the paper comes back.
    expect((await write("anonymous_callme", true)).status).toBe(200);
    const documentId = await uploaded(id, {
      origin: "generated",
      generationDocumentId: generation,
    });
    const [reviewed, edited] = await Promise.all([
      accept(id, documentId, {}),
      write("none", false),
    ]);
    expect([reviewed.status, edited.status]).toEqual([200, 200]);
    const view = await profiling(id);
    expect(view.signedDeclarations).toMatchObject({
      jobboerseChoice: "full",
      baContactConsent: false,
    });
    expect(view.declarations).toMatchObject({ jobboerseChoice: "none", baContactConsent: false });
    expect((await events(id, "signed_declaration_recorded")).map((row) => row.details)).toEqual([
      {
        documentId,
        formCode: "tl407",
        formVersion: "08-2025",
        declarations: ["jobboerseChoice", "baContactConsent"],
      },
    ]);
  });

  it("refuses an acceptance without its record, in the future or before the generation", async () => {
    const id = await participant();
    const { documentId: generation } = await readJson(await generate(id), Tl407Generation);
    const documentId = await uploaded(id, {
      origin: "generated",
      generationDocumentId: generation,
    });
    expect(await codesOf(await review(id, documentId, { decision: "accepted" }))).toEqual([
      { code: "scan_required", pointer: "/scan" },
    ]);
    const scan = {
      participantSignedOn: await berlinDay(1),
      profilerSignedOn: await berlinDay(-1),
      confirmations: ["signatures_present"],
      declarations: { kind: "as_printed" },
    };
    expect(await codesOf(await review(id, documentId, { decision: "accepted", scan }))).toEqual([
      { code: "signature_in_future", pointer: "/scan/participantSignedOn" },
      { code: "signature_before_generation", pointer: "/scan/profilerSignedOn" },
      { code: "confirmation_required", pointer: "/scan/confirmations" },
    ]);
    const rejected = await review(id, documentId, {
      decision: "rejected",
      reasonCode: "incomplete",
    });
    expect(rejected.status).toBe(200);
    expect((await profiling(id)).tl407Scans[0]!.review).toMatchObject({
      state: "rejected",
      reasonCode: "incomplete",
    });
  });
});

describe("the projection of signed paper (ba-forms.md, declarations to the BA)", () => {
  it("shows the latest signed paper's declarations; the guard keeps the earliest", async () => {
    const id = await participant();
    await inProgress(id);
    const paper = async (signedOn: string, jobboerseChoice: string) => {
      const documentId = await uploaded(id, { origin: "external_paper" });
      await accept(id, documentId, {
        participantSignedOn: signedOn,
        profilerSignedOn: signedOn,
        formVersion: "08-2025",
        declarations: { kind: "as_marked", jobboerseChoice, baContactConsent: true },
      });
      return documentId;
    };
    const older = await berlinDay(-10);
    const newer = await berlinDay(-3);
    await paper(older, "full");
    const latest = await paper(newer, "none");
    const view = await profiling(id);
    expect(view.tl407SignedOn).toBe(older);
    expect(view.signedDeclarations).toEqual({
      documentId: latest,
      formVersion: "08-2025",
      signedOn: newer,
      acceptedAt: expect.any(String),
      jobboerseChoice: "none",
      baContactConsent: true,
    });
    expect(view.profilingDoneSupported).toBeNull();
  });

  it("withholds a completion no usable paper supports, keeping its date (Q191, Q200)", async () => {
    const id = await participant();
    await inProgress(id);
    const external = async (signedOn: string) => {
      const documentId = await uploaded(id, { origin: "external_paper" });
      await accept(id, documentId, {
        participantSignedOn: signedOn,
        profilerSignedOn: signedOn,
        formVersion: "08-2025",
        declarations: { kind: "as_marked", jobboerseChoice: null, baContactConsent: null },
      });
      return documentId;
    };
    const completedOn = await berlinDay(-10);
    const first = await external(completedOn);
    expect((await complete(id, completedOn)).status).toBe(200);
    await external(await berlinDay(-5));
    expect((await profiling(id)).profilingDoneSupported).toBe(true);
    const quarantined = await request(
      "POST",
      `/participations/${id}/documents/${first}/quarantine`,
      projectLead,
      { reasonCode: "suspected_wrong_person" },
    );
    expect(quarantined.status).toBe(200);
    const view = await profiling(id);
    expect(view).toMatchObject({
      profilingStatus: "profiling_done",
      profilingDoneOn: completedOn,
      profilingDoneSupported: false,
    });
    const facts = await db.transaction((tx) =>
      dbGuardFacts.facts(tx, { participationId: id, currentRequest: null }),
    );
    expect(facts.profilingDone).toBeUndefined();
    expect(facts.tl407Signed?.validOn).toBe(await berlinDay(-5));
  });
});

describe("wrong paper (Q183)", () => {
  it("lets the PL delete a scan before its review; an accepted one is immutable", async () => {
    const id = await participant();
    const wrong = await uploaded(id, { origin: "external_paper" });
    const remove = (documentId: string, reason: string, as: string = projectLead) =>
      request("DELETE", `/participations/${id}/documents/${documentId}?reasonCode=${reason}`, as);
    await expectProblem(await remove(wrong, "wrong_person", consultant), 403, "forbidden");
    expect(await codesOf(await remove(wrong, "duplicate"))).toEqual([
      { code: "delete_reason_not_allowed", pointer: "/reasonCode" },
    ]);
    expect((await remove(wrong, "wrong_person")).status).toBe(204);
    const accepted = await uploaded(id, { origin: "external_paper" });
    await accept(id, accepted, {
      formVersion: "08-2025",
      declarations: { kind: "as_marked", jobboerseChoice: "full", baContactConsent: true },
    });
    expect(await codesOf(await remove(accepted, "wrong_person"))).toEqual([
      { code: "document_immutable", pointer: "" },
    ]);
    expect((await profiling(id)).tl407Scans.map((scan) => scan.documentId)).toEqual([accepted]);
  });

  it("quarantines at once: no opening, no fact, no profiling_done; lifting restores them", async () => {
    const id = await participant();
    await inProgress(id);
    const { documentId: generation } = await readJson(await generate(id), Tl407Generation);
    const documentId = await uploaded(id, {
      origin: "generated",
      generationDocumentId: generation,
    });
    await accept(id, documentId, {});
    const quarantine = await request(
      "POST",
      `/participations/${id}/documents/${documentId}/quarantine`,
      projectLead,
      { reasonCode: "suspected_wrong_acceptance" },
    );
    expect(quarantine.status).toBe(200);
    expect(await readJson(quarantine, DocumentView)).toMatchObject({
      quarantine: { reasonCode: "suspected_wrong_acceptance" },
      capabilities: { open: false, liftQuarantine: true, quarantine: false },
    });
    expect(
      await codesOf(
        await request(
          "POST",
          `/participations/${id}/documents/${documentId}/opening`,
          consultant,
          {},
        ),
      ),
    ).toEqual([{ code: "document_quarantined", pointer: "" }]);
    const view = await profiling(id);
    expect(view.tl407SignedOn).toBeNull();
    expect(view.tl407Scans[0]!.capabilities).toMatchObject({ open: false, liftQuarantine: false });
    expect(view.transitions).toContainEqual({
      to: "profiling_done",
      allowed: false,
      refusal: "tl407_signed",
    });
    expect(await codesOf(await complete(id, await berlinDay()))).toEqual([
      { code: "tl407_signed", pointer: "" },
    ]);
    // Only whoever quarantined it, or the PL, lifts it.
    const lift = (as: string) =>
      request("POST", `/participations/${id}/documents/${documentId}/quarantine-lift`, as, {});
    await expectProblem(await lift(consultant), 403, "forbidden");
    expect((await lift(projectLead)).status).toBe(200);
    expect((await profiling(id)).tl407SignedOn).toBe(await berlinDay());
    expect((await complete(id, await berlinDay())).status).toBe(200);
    expect((await events(id, "document_quarantined")).map((row) => row.reason_code)).toEqual([
      "suspected_wrong_acceptance",
    ]);
    expect(await events(id, "document_quarantine_lifted")).toHaveLength(1);
  });
});

describe("the TL 407 facts and the snapshot rule (process-and-lifecycle.md, guards)", () => {
  it("counts a TL 407 accepted after the TG start's scheduled run only for a reconciliation", async () => {
    const id = await participant();
    await inProgress(id);
    const signedOn = await berlinDay(-3);
    const documentId = await uploaded(id, { origin: "external_paper" });
    await accept(id, documentId, {
      participantSignedOn: signedOn,
      profilerSignedOn: signedOn,
      formVersion: "08-2025",
      declarations: { kind: "as_marked", jobboerseChoice: "full", baContactConsent: true },
    });
    expect((await complete(id, signedOn)).status).toBe(200);
    // The TG started yesterday; its run at 04:15 Berlin came before the acceptance just now.
    const tgStart = await berlinDay(-1);
    const today = await berlinDay();
    const facts = await db.transaction((tx) =>
      dbGuardFacts.facts(tx, { participationId: id, currentRequest: null }),
    );
    expect(facts.profilingDone?.validOn).toBe(signedOn);
    expect(facts.tl407Signed).toEqual({ validOn: signedOn, recordedAt: expect.any(Date) });
    const before = { validOn: signedOn, recordedAt: new Date(`${signedOn}T09:00:00Z`) };
    const enter = (entryKind: TgEntryKind) =>
      canTransition("main", "informed", "active_in_tg", {
        projectType: "ta_tg",
        current: {
          status: "informed",
          profilingStatus: "profiling_done",
          dsvStatus: "dsv_signed",
        },
        actor:
          entryKind === "reconciliation"
            ? { type: "user", staffUserId: projectLead as string }
            : { type: "system" },
        entryKind,
        today,
        ...(entryKind !== "reconciliation" && { scheduledAt: scheduledAt(tgStart, "04:15") }),
        wave: {
          id: "wave-scenario",
          code: "W",
          signingDeadline: signedOn,
          defaultTgStart: tgStart,
          defaultTgEnd: "2099-12-31",
          latestEntryDate: "2099-12-31",
        },
        participation: { tgStart: null, offerDeadline: null },
        // Synthetic DSV and ASU facts recorded in time: only the profiling fact is late.
        facts: { ...facts, dsvFullyExecuted: before, asuRegisteredWithProof: before },
      });
    expect(enter("scheduled_entry_catchup")).toEqual({
      ok: false,
      code: "guard_failed",
      failedGuards: ["profiling_done_or_approved_exception"],
    });
    expect(enter("reconciliation")).toEqual({ ok: true, flagForReview: true });
  });
});
