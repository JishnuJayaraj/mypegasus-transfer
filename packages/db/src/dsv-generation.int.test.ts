import { dsvSourceCanonical, type DsvSource } from "@transfer/domain";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectIds, seedStaffUserIds, seedWaves } from "./seed";
import {
  auditContext,
  call,
  informedParticipation,
  pl,
  resetTestDatabase,
  testDatabaseUrls,
  textDates,
} from "./testing";

// The DSV's generation (process-and-lifecycle.md, the DSV: generation; data-protection.md,
// generated forms) as transfer_app calls the functions: the project's template pin,
// `record_form_generation` for the DSV with its deadline and source token, the token equal to the
// domain's canonical text, and the generation's currency. Synthetic values only.
const urls = testDatabaseUrls();
const app = new Client({ connectionString: urls.app, types: textDates });
const owner = new Client({ connectionString: urls.owner, types: textDates });
const failsWith = (message: string) => ({ code: "P0001", message });
const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const { consultant, backOffice } = seedStaffUserIds;
const asConsultant = auditContext({ actorType: "user", staffUserId: consultant });
const asBackOffice = auditContext({ actorType: "user", staffUserId: backOffice });
const { werkNord, lagerSued, verwaltung } = seedProjectIds;
const w1 = seedWaves.find((wave) => wave.code === "W1")!;
const organisation = "a".repeat(64);
const sources = JSON.stringify({ profile: 0, profiling: 0, assessment: 0, unemployment: 0 });

beforeAll(() => Promise.all([app.connect(), owner.connect()]));
afterAll(() => Promise.all([app.end(), owner.end()]));
beforeEach(() => resetTestDatabase({ seed: true, active: true }));

const one = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows[0];

/** An informed participation of Werk Nord in W1 with a synthetic identity and address. */
async function participation(options: { address?: boolean; projectId?: string } = {}) {
  const projectId = options.projectId ?? werkNord;
  const id = await informedParticipation(app, {
    projectId,
    ...(projectId === werkNord && { entryWaveId: w1.id }),
  });
  await owner.query(
    `insert into participant_identity
       (participation_id, project_id, personnel_number, last_name, first_name, birth_date)
     values ($1, $2, $3, 'Doğan-Großmann "<b>"', 'Łucja Ayşe', '2051-07-29')`,
    [id, projectId, `SYN-${id.slice(-8)}`],
  );
  await owner.query(
    `insert into participant_details
       (participation_id, project_id, address_street, address_postal_code, address_city, address_country)
     values ($1, $2, $3, $4, $5, $6)`,
    options.address === false
      ? [id, projectId, null, null, null, null]
      : [id, projectId, "Weißdornweg 7", "99999", "Beispielstadt", "DE"],
  );
  return id;
}

const pin = (version: string, context = pl, projectId: string = werkNord) =>
  call(app, "update_project", { id: projectId, context, dsvTemplateVersion: version });

const personOf = async (id: string) => (await one("select form_person($1) as p", [id])).p;
const tokenOf = async (id: string, org = organisation) =>
  (await one("select dsv_source_token($1, $2) as t", [id, org])).t as string;

type Generation = {
  context?: string;
  version?: string;
  deadline?: string;
  kind?: "wave" | "explicit";
  token?: string;
  person?: object;
  checklist?: string | null;
  employerSha256?: string | null;
  formCode?: string;
};

/** A DSV recorded by `context` (the PL by default) with the wave's deadline; its generation id. */
async function generate(id: string, overrides: Generation = {}) {
  return call(app, "record_form_generation", {
    context: overrides.context ?? pl,
    participationId: id,
    generationId: randomUUID(),
    documentId: randomUUID(),
    formCode: overrides.formCode ?? "dsv",
    formVersion: overrides.version ?? "v1",
    sources,
    person: JSON.stringify(overrides.person ?? (await personOf(id))),
    sourceToken: overrides.token ?? (await tokenOf(id)),
    organisationSha256: organisation,
    declarations: null,
    confirmedWarnings: [],
    anlage: false,
    sizeBytes: 2048,
    contentSha256: hex(),
    keyId: hex(8),
    wrappedKey: randomBytes(60),
    checklist: overrides.checklist === undefined ? "[]" : overrides.checklist,
    employerSha256: overrides.employerSha256 ?? null,
    offerDeadline: overrides.deadline ?? w1.signingDeadline,
    deadlineKind: overrides.kind ?? "wave",
  });
}

const current = async (generationId: string, org = organisation) =>
  (await one("select dsv_generation_current($1, $2) as c", [generationId, org])).c as boolean;

describe("dsv_source_token", () => {
  it("hashes the domain's canonical text: the person, dates, wave, template, customer and TG", async () => {
    await pin("v1");
    const id = await participation();
    const source: DsvSource = {
      templateVersion: "v1",
      firstName: "Łucja Ayşe",
      lastName: 'Doğan-Großmann "<b>"',
      birthDate: "2051-07-29",
      street: "Weißdornweg 7",
      postalCode: "99999",
      city: "Beispielstadt",
      country: "DE",
      tgStart: w1.defaultTgStart,
      tgEnd: w1.defaultTgEnd,
      entryWaveId: w1.id,
      customerName: (await one("select customer_name from project where id = $1", [werkNord]))
        .customer_name,
      organisationSha256: organisation,
    };
    expect(await tokenOf(id)).toBe(sha256(dsvSourceCanonical(source)));
    const blank = await participation({ address: false });
    await owner.query("update project set dsv_template_version = null where id = $1", [werkNord]);
    expect(await tokenOf(blank)).toBe(
      sha256(
        dsvSourceCanonical({
          ...source,
          templateVersion: null as never,
          street: null,
          postalCode: null,
          city: null,
          country: null,
        }),
      ),
    );
  });
});

describe("the project's DSV template pin (update_project)", () => {
  it("is the PL's, in a ta_tg project, audited with the version it replaced", async () => {
    await expect(pin("v1", asBackOffice)).rejects.toMatchObject(failsWith("actor_not_allowed"));
    await expect(pin("v1", pl, verwaltung)).rejects.toMatchObject(failsWith("not_ta_tg"));
    await pin("v1");
    await expect(pin("v1")).rejects.toMatchObject(failsWith("project_unchanged"));
    await pin("v2");
    await expect(pin("1")).rejects.toMatchObject(failsWith("invalid_argument"));
    await expect(
      call(app, "update_project", {
        id: werkNord,
        context: pl,
        name: "Neu",
        dsvTemplateVersion: "v1",
      }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
    const events = await owner.query(
      `select details from audit_event where event_type = 'dsv_template_pinned'
       and project_id = $1 and participation_id is null order by seq`,
      [werkNord],
    );
    expect(events.rows.map((row) => row.details)).toEqual([
      { templateVersion: "v1" },
      { templateVersion: "v2", previousVersion: "v1" },
    ]);
  });

  it("is fixed from the project's first DSV generation", async () => {
    await pin("v1");
    await generate(await participation());
    await expect(pin("v2")).rejects.toMatchObject(failsWith("template_pinned"));
    expect(
      (await one("select dsv_template_version from project where id = $1", [werkNord]))
        .dsv_template_version,
    ).toBe("v1");
  });
});

describe("record_form_generation: the DSV", () => {
  it("stores the working copy and its provenance for the PL and back office, audited by codes only", async () => {
    await pin("v1");
    const id = await participation();
    const byPl = await generate(id);
    await generate(id, { context: asBackOffice, kind: "explicit", deadline: "2091-02-20" });
    const rows = await owner.query(
      `select g.form_code, g.form_version, g.offer_deadline, g.deadline_kind, g.checklist,
         d.type, d.catalog_version, d.retention_class
       from form_generation g join document d on d.id = g.document_id
       where g.participation_id = $1 order by g.generated_at, g.id`,
      [id],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find((row) => row.deadline_kind === "wave")).toEqual({
      form_code: "dsv",
      form_version: "v1",
      offer_deadline: w1.signingDeadline,
      deadline_kind: "wave",
      checklist: [],
      type: "dsv_form",
      catalog_version: 8,
      retention_class: "form_working_copy",
    });
    const audit = await owner.query(
      `select event_type, details from audit_event where participation_id = $1
       and event_type::text in ('dsv_form_generated', 'form_generated') order by seq`,
      [id],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      "dsv_form_generated",
      "dsv_form_generated",
    ]);
    expect(audit.rows[0].details).toEqual({
      documentId: expect.any(String),
      templateVersion: "v1",
      deadlineKind: "wave",
    });
    expect(JSON.stringify(audit.rows)).not.toContain("2091-02-15");
    expect(byPl).toEqual(expect.any(String));
  });

  it("refuses the consultant, an open offer and every state it can't be generated in", async () => {
    const id = await participation();
    await expect(generate(id)).rejects.toMatchObject(failsWith("dsv_not_generatable"));
    await pin("v1");
    await expect(generate(id, { context: asConsultant })).rejects.toMatchObject(
      failsWith("actor_not_allowed"),
    );
    await expect(
      generate(id, {
        context: auditContext({ actorType: "user", staffUserId: backOffice, onBehalfOf: id }),
      }),
    ).rejects.toMatchObject({ code: "P0001" });
    await owner.query("update participation set dsv_status = 'dsv_offered' where id = $1", [id]);
    await expect(generate(id)).rejects.toMatchObject(failsWith("dsv_offer_open"));
    await owner.query("update participation set dsv_status = 'dsv_signed' where id = $1", [id]);
    await expect(generate(id)).rejects.toMatchObject(failsWith("dsv_not_generatable"));
    // no wave: no effective dates
    const waveless = await informedParticipation(app, { projectId: werkNord });
    await expect(generate(waveless)).rejects.toMatchObject(failsWith("dsv_not_generatable"));
    // a project not active
    await call(app, "update_project", { id: lagerSued, context: pl, dsvTemplateVersion: "v1" });
    const inactive = await call(app, "create_participation", { projectId: lagerSued, context: pl });
    await expect(generate(inactive)).rejects.toMatchObject(failsWith("dsv_not_generatable"));
  });

  it("validates the deadline: the wave's as it is now, only for a first offer, inside its bounds", async () => {
    await pin("v1");
    const id = await participation();
    await expect(generate(id, { deadline: "2091-02-14" })).rejects.toMatchObject(
      failsWith("source_changed"),
    );
    // explicit: today ≤ deadline ≤ latest entry date (2091-03-15) and ≤ the TG start (2091-03-01)
    for (const deadline of ["2020-01-01", "2091-03-02"]) {
      await expect(generate(id, { kind: "explicit", deadline })).rejects.toMatchObject(
        failsWith("offer_deadline_invalid"),
      );
    }
    await generate(id, { kind: "explicit", deadline: "2091-03-01" });
    await owner.query("update participation set dsv_status = 'dsv_expired' where id = $1", [id]);
    await expect(generate(id)).rejects.toMatchObject(failsWith("offer_deadline_invalid"));
    await generate(id, { kind: "explicit", deadline: "2091-02-20" });
  });

  it("compares the printed sources under the lock", async () => {
    await pin("v1");
    const id = await participation();
    await expect(generate(id, { token: hex() })).rejects.toMatchObject(failsWith("source_changed"));
    await expect(
      generate(id, { person: { ...(await personOf(id)), city: "Anderswo" } }),
    ).rejects.toMatchObject(failsWith("source_changed"));
    await expect(generate(id, { version: "v2" })).rejects.toMatchObject(
      failsWith("source_changed"),
    );
  });

  it("takes a checklist and no employer fingerprint; the BA forms take no deadline", async () => {
    await pin("v1");
    const id = await participation({ address: false });
    await expect(generate(id, { checklist: null })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await expect(generate(id, { employerSha256: hex() })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await expect(generate(id, { version: "09-2021" })).rejects.toMatchObject(
      failsWith("invalid_argument"),
    );
    await expect(
      generate(id, { formCode: "kug200b", version: "09-2021", employerSha256: hex() }),
    ).rejects.toMatchObject(failsWith("invalid_argument"));
    await generate(id, {
      checklist: JSON.stringify([{ code: "required_blank", key: "address" }]),
    });
  });
});

describe("dsv_generation_current (process-and-lifecycle.md, the DSV: generation as built)", () => {
  it("holds until a printed value, the TG, the wave's deadline or the customer changes", async () => {
    await pin("v1");
    const id = await participation();
    const generation = await generate(id);
    expect(await current(generation)).toBe(true);
    expect(await current(generation, "b".repeat(64))).toBe(false);
    expect(await current(randomUUID())).toBe(false);

    await owner.query(
      "update participant_details set address_street = 'Ahornweg 2' where participation_id = $1",
      [id],
    );
    expect(await current(generation)).toBe(false);
    await owner.query(
      "update participant_details set address_street = 'Weißdornweg 7' where participation_id = $1",
      [id],
    );
    expect(await current(generation)).toBe(true);

    await owner.query("update project set customer_name = 'Andere GmbH' where id = $1", [werkNord]);
    expect(await current(generation)).toBe(false);
  });

  it("goes stale for the wave's deadline when the wave's moves, not for an explicit one", async () => {
    await pin("v1");
    const id = await participation();
    const wave = await generate(id);
    const explicit = await generate(id, { kind: "explicit", deadline: "2091-02-20" });
    await owner.query(
      "update project_entry_wave set signing_deadline = '2091-02-16' where id = $1",
      [w1.id],
    );
    expect(await current(wave)).toBe(false);
    expect(await current(explicit)).toBe(true);
    await owner.query(
      "update form_generation set offer_deadline = berlin_today() - 1 where id = $1",
      [explicit],
    );
    expect(await current(explicit)).toBe(false);
  });
});

describe("grants", () => {
  it("keeps the token helper internal", async () => {
    await expect(
      app.query("select dsv_source_token($1, $2)", [randomUUID(), organisation]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
