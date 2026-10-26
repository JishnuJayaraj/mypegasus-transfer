import { describe, expect, it } from "vitest";
import type { EducationRow } from "../self-service/values";
import { FieldMap } from "./field-map";
import type { FormInput } from "./input";
import { testMeasure } from "./testing/maps";
import {
  checkTl407,
  presentSensitiveValues,
  schoolQualificationCheck,
  tl407FieldSource,
  tl407Label,
  tl407ProfilerReadiness,
  tl407ReadinessSummary,
  unconfirmedWarnings,
} from "./tl407";

// A small TL 407 map with the real keys (the real map's keys are checked in `packages/forms`).

const box = { width: 104, height: 14 };
const map = FieldMap.parse({
  formCode: "tl407",
  version: "08-2025",
  label: "TL 407 08/2025",
  fontSize: 10,
  minFontSize: 8,
  missingRequired: "error",
  anlage: {
    template: "anlage-profilingbogen:v1",
    title: "Anlage zum Profilingbogen (TL 407 08/2025)",
    firstName: "firstName",
    lastName: "lastName",
    birthDate: "birthDate",
  },
  entries: [
    {
      key: "carrier.name",
      label: "1 Name",
      kind: "text",
      fields: ["t1"],
      required: true,
      box,
      multiline: false,
    },
    {
      key: "firstName",
      label: "6 Vorname",
      kind: "text",
      fields: ["t6"],
      required: true,
      box,
      multiline: false,
    },
    {
      key: "lastName",
      label: "7 Nachname",
      kind: "text",
      fields: ["t7"],
      required: true,
      box,
      multiline: false,
    },
    { key: "birthDate", label: "8 Geburtsdatum", kind: "date", fields: ["d8"], required: true },
    {
      key: "pensionInsuranceNumber",
      label: "20 Rentenversicherungsnummer",
      kind: "text",
      fields: ["t20"],
      required: true,
      box,
      multiline: false,
      identifier: { maxLength: 12 },
    },
    {
      key: "unemployedFrom",
      label: "34 Arbeitslos seit/ab",
      kind: "date",
      fields: ["d34"],
      required: true,
    },
    {
      key: "unemployedUntil",
      label: "35 Arbeitslosigkeit endet am",
      kind: "date",
      fields: ["d35"],
      required: false,
    },
    {
      kind: "table",
      key: "education",
      label: "39 Schul- und Berufsausbildung",
      required: true,
      rows: 1,
      markerColumn: "institution",
      columns: [
        {
          key: "institution",
          label: "Einrichtung",
          kind: "text",
          fields: ["e1"],
          box,
          multiline: false,
        },
      ],
      dateRanges: [],
      timeRanges: [],
    },
    {
      key: "maxDistanceKm",
      label: "49 Maximale Entfernung (km)",
      kind: "text",
      fields: ["t49"],
      required: true,
      group: "maxDistance",
      box,
      multiline: false,
    },
    {
      key: "overallAssessment",
      label: "A. Gesamteinschätzung",
      kind: "text",
      fields: ["tA"],
      required: false,
      box: { width: 64, height: 40 },
      multiline: true,
    },
  ],
  dateRanges: [{ from: "unemployedFrom", to: "unemployedUntil" }],
  plausibility: { birthDate: "birthDate" },
  neverFilled: [],
});

const school: EducationRow = {
  from: "2058-08-01",
  to: "2068-07-15",
  institution: "Gesamtschule Beispielstadt",
  qualification: "Abitur",
  completed: true,
};
const marked: EducationRow = { ...school, highestSchoolQualification: true };

const input = (values: FormInput["values"] = {}, education = ["Gesamtschule"]): FormInput => ({
  formCode: "tl407",
  projectType: "ta_tg",
  values: {
    "carrier.name": "Beispiel TG mbH",
    firstName: "Łucja",
    lastName: "Doğan",
    birthDate: "2051-07-29",
    pensionInsuranceNumber: "12290751D123",
    unemployedFrom: "2091-04-01",
    unemployedUntil: null,
    maxDistanceKm: "50",
    ...values,
  },
  tables: { education: education.map((institution) => ({ institution })) },
});
const today = "2091-03-01";

describe("schoolQualificationCheck (Q196, Q198)", () => {
  it("takes the marked row", () => {
    expect(schoolQualificationCheck([school, marked])).toEqual([]);
  });

  it("asks for the explicit answer without any row too, never reading absence as 'none'", () => {
    for (const none of [null, []]) {
      expect(schoolQualificationCheck(none)).toEqual([
        { code: "school_qualification_none", key: "education" },
      ]);
    }
  });

  it("asks for the explicit answer when no row is marked, never inferring it", () => {
    // "Abitur" in an unmarked row says nothing: the participant hasn't designated it.
    expect(schoolQualificationCheck([school])).toEqual([
      { code: "school_qualification_none", key: "education" },
    ]);
  });
});

describe("checkTl407 (ba-forms.md, validation before rendering)", () => {
  it("needs a version in use", () => {
    expect(checkTl407(input(), null, [marked], today, testMeasure)).toEqual({
      errors: [{ code: "form_version_unavailable", key: "form" }],
      warnings: [],
      layout: null,
    });
  });

  it("lays out a valid input with its overflow", () => {
    const check = checkTl407(
      input({}, ["Gesamtschule", "Berufsschule"]),
      map,
      [marked],
      today,
      testMeasure,
    );
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual([]);
    expect(check.layout!.overflow).toEqual([{ kind: "table", key: "education" }]);
  });

  it("refuses with errors and lays nothing out; warns of a reversed unemployment period", () => {
    const check = checkTl407(
      input({ lastName: "Иванов", unemployedFrom: null }),
      map,
      [school],
      today,
      testMeasure,
    );
    expect(check.errors).toEqual([
      { code: "character_unsupported", key: "lastName" },
      { code: "required_missing", key: "unemployedFrom" },
    ]);
    expect(check.layout).toBeNull();
    expect(check.warnings).toEqual([{ code: "school_qualification_none", key: "education" }]);
    const reversed = checkTl407(
      input({ unemployedUntil: "2091-01-01" }),
      map,
      [marked],
      today,
      testMeasure,
    );
    expect(reversed.warnings).toEqual([{ code: "range_reversed", key: "unemployedUntil" }]);
  });

  it("names each warning still to confirm, once", () => {
    const check = checkTl407(
      input({ birthDate: "2085-01-01", unemployedUntil: "2091-01-01" }),
      map,
      [school],
      today,
      testMeasure,
    );
    expect(unconfirmedWarnings(check, [])).toEqual([
      "range_reversed",
      "age_implausible",
      "school_qualification_none",
    ]);
    expect(unconfirmedWarnings(check, ["range_reversed", "age_implausible"])).toEqual([
      "school_qualification_none",
    ]);
  });
});

describe("checkTl407 without education rows (Q199)", () => {
  it("asks for 'Kein Schulabschluss' instead of a missing table, and lays the form out blank there", () => {
    const check = checkTl407(input({}, []), map, null, today, testMeasure);
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual([{ code: "school_qualification_none", key: "education" }]);
    expect(check.layout!.fields.map((field) => field.name)).not.toContain("e1");
    // Another missing field still refuses.
    const other = checkTl407(input({ birthDate: null }, []), map, [], today, testMeasure);
    expect(other.errors).toEqual([{ code: "required_missing", key: "birthDate" }]);
  });
});

describe("tl407Label", () => {
  it("names a field, a group, a table, a column and the form as printed", () => {
    expect(tl407Label(map, "lastName")).toBe("7 Nachname");
    expect(tl407Label(map, "maxDistance")).toBe("49 Maximale Entfernung (km)");
    expect(tl407Label(map, "education")).toBe("39 Schul- und Berufsausbildung");
    expect(tl407Label(map, "education.institution")).toBe(
      "39 Schul- und Berufsausbildung: Einrichtung",
    );
    expect(tl407Label(map, "education.unknown")).toBe("education.unknown");
    expect(tl407Label(map, "form")).toBe("TL 407 08/2025");
    expect(tl407Label(null, "form")).toBe("TL 407");
  });
});

describe("tl407ProfilerReadiness (data-protection.md, the readiness projection)", () => {
  it("gives the profiler every code, the overflow and the version, labelled", () => {
    const check = checkTl407(
      {
        ...input({}, ["A", "B"]),
        tables: { education: [{ institution: "A" }, { institution: "Б" }] },
      },
      map,
      [school],
      today,
      testMeasure,
    );
    const token = "a".repeat(64);
    expect(tl407ProfilerReadiness(map, check, token)).toEqual({
      view: "profiler",
      formVersion: "08-2025",
      ready: false,
      sourceToken: token,
      errors: [
        {
          code: "character_unsupported",
          key: "education.institution",
          row: 1,
          label: "39 Schul- und Berufsausbildung: Einrichtung",
        },
      ],
      warnings: [
        {
          code: "school_qualification_none",
          key: "education",
          label: "39 Schul- und Berufsausbildung",
        },
      ],
      overflow: [],
    });
    const ready = checkTl407(input({}, ["A", "B"]), map, [marked], today, testMeasure);
    expect(tl407ProfilerReadiness(map, ready, token)).toMatchObject({
      ready: true,
      overflow: [{ kind: "table", key: "education", label: "39 Schul- und Berufsausbildung" }],
    });
    const none = checkTl407(input(), null, null, today, testMeasure);
    expect(tl407ProfilerReadiness(null, none, token)).toMatchObject({
      formVersion: null,
      ready: false,
    });
  });
});

describe("tl407FieldSource", () => {
  it("names the catalog field of a key, the assessment's by its group", () => {
    expect(tl407FieldSource("beeFrom")).toBe("tgStart");
    expect(tl407FieldSource("carrier.name")).toBeNull();
    expect(tl407FieldSource("assessment.health.rating")).toBe("profilingHealthAssessment");
    expect(tl407FieldSource("assessment.initiative.text")).toBe("profilingAssessment");
    expect(tl407FieldSource("nextSteps")).toBe("nextSteps");
    expect(() => tl407FieldSource("unknown")).toThrow(RangeError);
  });
});

const knowsAllBut =
  (...hidden: string[]) =>
  (field: string) =>
    !hidden.includes(field);

describe("tl407ReadinessSummary (the PL's projection: presence, no decryption)", () => {
  it("names the missing fields the PL may know about, and no warning or overflow", () => {
    const summary = tl407ReadinessSummary(
      input({ birthDate: null, pensionInsuranceNumber: null, unemployedFrom: null }),
      map,
      today,
      knowsAllBut("pensionInsuranceNumber", "unemploymentPeriod"),
    );
    expect(summary).toEqual({
      view: "project_lead",
      ready: false,
      missing: [{ key: "birthDate", label: "8 Geburtsdatum" }],
    });
    expect(Object.keys(summary).toSorted()).toEqual(["missing", "ready", "view"]);
  });

  it("is ready when nothing the PL may know about is missing; the organisation always counts", () => {
    const hidden = knowsAllBut("unemploymentPeriod");
    expect(tl407ReadinessSummary(input({ unemployedFrom: null }), map, today, hidden)).toEqual({
      view: "project_lead",
      ready: true,
      missing: [],
    });
    expect(
      tl407ReadinessSummary(input({ "carrier.name": null }), map, today, () => false),
    ).toMatchObject({ ready: false, missing: [{ key: "carrier.name" }] });
    expect(tl407ReadinessSummary(input(), null, today, hidden)).toEqual({
      view: "project_lead",
      ready: false,
      missing: [],
    });
  });

  it("counts a sensitive field as present by its flag, never by its value", () => {
    const all = Object.fromEntries(
      [
        "pensionInsuranceNumber",
        "nationality",
        "entryToGermanyDate",
        "residenceStatus",
        "buergergeld",
        "healthRestrictions",
        "severeDisability",
      ].map((field) => [field, true]),
    ) as Parameters<typeof presentSensitiveValues>[0];
    const present = presentSensitiveValues(all);
    expect(Object.values(present).every((value) => value !== null)).toBe(true);
    const absent = presentSensitiveValues({ ...all, pensionInsuranceNumber: false });
    expect(absent.pensionInsuranceNumber).toBeNull();
  });
});
