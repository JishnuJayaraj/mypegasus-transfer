import { describe, expect, it } from "vitest";
import {
  dsvDeadline,
  dsvGeneratedFact,
  dsvGenerationBlockers,
  DsvGenerationInput,
  dsvGenerationProblem,
  dsvPinProblem,
  dsvSourceCanonical,
  dsvTemplateRef,
  dsvTemplateUsable,
  isDsvReoffer,
  validateDsvSource,
  type DsvGenerationState,
  type DsvSource,
} from "./generation";

const source: DsvSource = {
  templateVersion: "v1",
  firstName: "Łucja Ayşe",
  lastName: "Doğan-Großmann",
  birthDate: "2051-07-29",
  street: "Weißdornweg 7",
  postalCode: "99999",
  city: "Beispielstadt",
  country: null,
  tgStart: "2091-04-01",
  tgEnd: "2092-03-31",
  entryWaveId: "00000000-0000-4000-8000-000000000001",
  customerName: 'Beispiel <GmbH> & "Co"',
  organisationSha256: "a".repeat(64),
};

const state: DsvGenerationState = {
  projectType: "ta_tg",
  projectStatus: "active",
  status: "informed",
  dsvStatus: "not_offered",
  entryWaveId: "w",
  tgStart: "2091-04-01",
  tgEnd: "2092-03-31",
  templateVersion: "v1",
};

describe("dsvSourceCanonical", () => {
  it("lists every printed source in a fixed order, values as JSON strings or null", () => {
    expect(dsvSourceCanonical(source).split("\n")).toEqual([
      "dsv-sources:v1",
      'templateVersion="v1"',
      'firstName="Łucja Ayşe"',
      'lastName="Doğan-Großmann"',
      'birthDate="2051-07-29"',
      'street="Weißdornweg 7"',
      'postalCode="99999"',
      'city="Beispielstadt"',
      "country=null",
      'tgStart="2091-04-01"',
      'tgEnd="2092-03-31"',
      'entryWaveId="00000000-0000-4000-8000-000000000001"',
      'customerName="Beispiel <GmbH> & \\"Co\\""',
      `organisationSha256="${"a".repeat(64)}"`,
    ]);
  });

  it("changes with any printed value, the template and the wave", () => {
    const base = dsvSourceCanonical(source);
    for (const change of [
      { templateVersion: "v2" },
      { street: null },
      { tgEnd: "2092-03-30" },
      { entryWaveId: null },
      { customerName: "Andere GmbH" },
    ] satisfies Partial<DsvSource>[]) {
      expect(dsvSourceCanonical({ ...source, ...change })).not.toBe(base);
    }
  });
});

describe("dsvGenerationBlockers", () => {
  it("allows a first offer and a re-offer after a decline or expiry", () => {
    for (const dsvStatus of ["not_offered", "dsv_declined", "dsv_expired"] as const) {
      expect(dsvGenerationBlockers({ ...state, dsvStatus })).toEqual([]);
    }
  });

  it("refuses a ta_only project alone", () => {
    expect(
      dsvGenerationBlockers({ ...state, projectType: "ta_only", status: "withdrawn" }),
    ).toEqual(["not_ta_tg"]);
  });

  it("names every other blocker at once", () => {
    expect(
      dsvGenerationBlockers({
        ...state,
        projectStatus: "draft",
        status: "withdrawn",
        entryWaveId: null,
        tgEnd: null,
        templateVersion: null,
        dsvStatus: "dsv_offered",
      }),
    ).toEqual([
      "project_not_active",
      "participation_closed",
      "no_entry_wave",
      "tg_dates_missing",
      "dsv_template_not_pinned",
      "dsv_offer_open",
    ]);
    expect(dsvGenerationBlockers({ ...state, tgStart: null, dsvStatus: "dsv_signed" })).toEqual([
      "tg_dates_missing",
      "dsv_already_signed",
    ]);
  });
});

describe("dsvDeadline", () => {
  const context = {
    today: "2091-03-01",
    dsvStatus: "not_offered" as const,
    waveSigningDeadline: "2091-03-12",
    latestEntryDate: "2091-06-30",
    tgStart: "2091-04-01",
  };

  it("takes the wave's deadline for a first offer as the dialog showed it", () => {
    expect(dsvDeadline({ kind: "wave", shown: "2091-03-12" }, context)).toEqual({
      ok: true,
      deadline: "2091-03-12",
    });
    expect(dsvDeadline({ kind: "wave", shown: "2091-03-11" }, context)).toEqual({
      ok: false,
      problem: "source_changed",
    });
    expect(
      dsvDeadline({ kind: "wave", shown: "2091-03-12" }, { ...context, waveSigningDeadline: null }),
    ).toEqual({ ok: false, problem: "wave_deadline_missing" });
  });

  it("needs an explicit deadline for a re-offer", () => {
    expect(isDsvReoffer("not_offered")).toBe(false);
    expect(
      dsvDeadline({ kind: "wave", shown: "2091-03-12" }, { ...context, dsvStatus: "dsv_expired" }),
    ).toEqual({ ok: false, problem: "explicit_deadline_required" });
    expect(
      dsvDeadline(
        { kind: "explicit", date: "2091-03-20" },
        { ...context, dsvStatus: "dsv_expired" },
      ),
    ).toEqual({ ok: true, deadline: "2091-03-20" });
  });

  it("keeps today ≤ deadline ≤ latest entry and ≤ TG start, inclusive, failing closed", () => {
    const explicit = (date: string, more = {}) =>
      dsvDeadline({ kind: "explicit", date }, { ...context, ...more });
    expect(explicit("2091-03-01").ok).toBe(true);
    expect(explicit("2091-04-01").ok).toBe(true);
    for (const outcome of [
      explicit("2091-02-28"),
      explicit("2091-04-02"),
      explicit("2091-03-20", { latestEntryDate: "2091-03-19" }),
      explicit("2091-03-20", { latestEntryDate: null }),
      explicit("2091-03-20", { tgStart: null }),
    ]) {
      expect(outcome).toEqual({ ok: false, problem: "offer_deadline_invalid" });
    }
  });
});

describe("DsvGenerationInput", () => {
  it("takes no deadline by default and no unknown key", () => {
    const token = "b".repeat(64);
    expect(DsvGenerationInput.safeParse({ expectedSourceToken: token }).success).toBe(false);
    expect(
      DsvGenerationInput.safeParse({
        deadline: { kind: "explicit", date: "2091-02-30" },
        expectedSourceToken: token,
      }).success,
    ).toBe(false);
    expect(
      DsvGenerationInput.safeParse({
        deadline: { kind: "wave", shown: "2091-03-12", date: "2091-03-12" },
        expectedSourceToken: token,
      }).success,
    ).toBe(false);
    expect(
      DsvGenerationInput.parse({
        deadline: { kind: "wave", shown: "2091-03-12" },
        expectedSourceToken: token,
      }),
    ).toEqual({ deadline: { kind: "wave", shown: "2091-03-12" }, expectedSourceToken: token });
  });
});

describe("validateDsvSource", () => {
  const company = {
    name: "Beispiel Transfer GmbH",
    street: "Musterstraße",
    houseNumber: "1",
    postalCode: "99999",
    city: "Beispielstadt",
  };

  it("passes Latin extensions and lists a blank birth date and address for the hand", () => {
    expect(validateDsvSource(source, company)).toEqual({ errors: [], checklist: [] });
    expect(
      validateDsvSource(
        { ...source, birthDate: null, street: null, postalCode: null, city: null },
        company,
      ),
    ).toEqual({
      errors: [],
      checklist: [
        { code: "required_blank", key: "birthDate" },
        { code: "required_blank", key: "address" },
      ],
    });
  });

  it("refuses what the font can't print, by key, never by value", () => {
    expect(
      validateDsvSource(
        { ...source, lastName: "Ωmega", city: "Αθήνα", customerName: "客户" },
        { ...company, name: "Тест" },
      ).errors,
    ).toEqual([
      { code: "character_unsupported", key: "lastName" },
      { code: "character_unsupported", key: "address" },
      { code: "character_unsupported", key: "customerName" },
      { code: "character_unsupported", key: "transfergesellschaft" },
    ]);
    expect(validateDsvSource({ ...source, firstName: "Zeile\numbruch" }, company).errors).toEqual([
      { code: "character_unsupported", key: "firstName" },
    ]);
  });
});

describe("dsvGenerationProblem", () => {
  const generation = {
    sourceToken: "c".repeat(64),
    offerDeadline: "2091-03-12",
    deadlineKind: "wave" as const,
  };
  const current = { sourceToken: "c".repeat(64), waveSigningDeadline: "2091-03-12" };

  it("is current while the sources, the deadline and the wave's deadline hold", () => {
    expect(dsvGenerationProblem(generation, current, "2091-03-12")).toBeNull();
  });

  it("goes stale on a changed source, a passed deadline or a moved wave deadline", () => {
    expect(
      dsvGenerationProblem(generation, { ...current, sourceToken: "d".repeat(64) }, "2091-03-01"),
    ).toBe("dsv_generation_stale");
    expect(dsvGenerationProblem(generation, current, "2091-03-13")).toBe("dsv_generation_stale");
    expect(
      dsvGenerationProblem(
        generation,
        { ...current, waveSigningDeadline: "2091-03-15" },
        "2091-03-01",
      ),
    ).toBe("dsv_generation_stale");
  });

  it("keeps an explicit deadline when the wave's moves", () => {
    expect(
      dsvGenerationProblem(
        { ...generation, deadlineKind: "explicit" },
        { ...current, waveSigningDeadline: null },
        "2091-03-01",
      ),
    ).toBeNull();
  });
});

describe("templates and the pin", () => {
  it("refuses an unapproved template in production only", () => {
    expect(dsvTemplateRef("v1")).toBe("dsv:v1");
    expect(dsvTemplateUsable({ approvedForLive: false }, false)).toBe(true);
    expect(dsvTemplateUsable({ approvedForLive: false }, true)).toBe(false);
    expect(dsvTemplateUsable({ approvedForLive: true }, true)).toBe(true);
  });

  it("pins in a ta_tg project until its first generation", () => {
    const project = { type: "ta_tg" as const, pinned: null, generated: false };
    expect(dsvPinProblem(project, "v1")).toBeNull();
    expect(dsvPinProblem({ ...project, pinned: "v1" }, "v2")).toBeNull();
    expect(dsvPinProblem({ ...project, pinned: "v1" }, "v1")).toBe("project_unchanged");
    expect(dsvPinProblem({ ...project, pinned: "v1", generated: true }, "v2")).toBe(
      "template_pinned",
    );
    expect(dsvPinProblem({ ...project, type: "ta_only" }, "v1")).toBe("not_ta_tg");
  });
});

describe("dsvGeneratedFact (process-and-lifecycle.md, the DSV: generation as built)", () => {
  it("is the latest current generation, by its Berlin day and instant", () => {
    const at = (iso: string) => new Date(iso);
    expect(dsvGeneratedFact([])).toBeUndefined();
    expect(
      dsvGeneratedFact([
        { generatedOn: "2091-02-01", generatedAt: at("2091-02-01T08:00:00Z"), current: true },
        { generatedOn: "2091-02-03", generatedAt: at("2091-02-02T23:30:00Z"), current: true },
        { generatedOn: "2091-02-04", generatedAt: at("2091-02-04T08:00:00Z"), current: false },
      ]),
    ).toEqual({ validOn: "2091-02-03", recordedAt: at("2091-02-02T23:30:00Z") });
    expect(
      dsvGeneratedFact([
        { generatedOn: "2091-02-04", generatedAt: at("2091-02-04T08:00:00Z"), current: false },
      ]),
    ).toBeUndefined();
  });
});
