import { describe, expect, it } from "vitest";
import { kug200bInput, splitStreet, tl407Input, type Tl407Source } from "./input";
import { syntheticKug200b, syntheticTl407 } from "./testing/sources";

const emptyProfile: Tl407Source["profile"] = {
  gender: null,
  maritalStatus: null,
  educationHistory: null,
  workHistory: null,
  languageSkills: null,
  drivingLicence: null,
  vehicleAvailable: null,
  workingTimePreferences: null,
  jobWishes: null,
  desiredWorkLocations: null,
  maxCommuteDistance: null,
  earliestStartDate: null,
};
const emptySensitive: Tl407Source["sensitive"] = {
  pensionInsuranceNumber: null,
  nationality: null,
  entryToGermanyDate: null,
  residenceStatus: null,
  buergergeld: null,
  healthRestrictions: null,
  severeDisability: null,
};

describe("tl407Input (ba-forms.md, what is filled)", () => {
  it("fills §111 and the beE stay from the TG dates in ta_tg", () => {
    const { values, tables } = tl407Input(syntheticTl407);
    expect(values).toMatchObject({
      paragraph110: false,
      paragraph111: true,
      beeFrom: "2091-04-01",
      beeTo: "2092-03-31",
      "carrier.name": "Beispiel Transfergesellschaft mbH",
      street: "Weißdornweg",
      houseNumber: "7b",
      nationality: "other",
      otherNationality: "Polen",
      gender: "female",
      buergergeld: "no",
      drivingLicence: "B, C1",
      vehicleAvailable: "yes",
      weeklyHours: "30,5",
      maxDistanceKm: "50",
      maxDistanceScope: null,
      jobboerseChoice: "anonymous_callme",
      "assessment.health.rating": "no_need",
      "assessment.otherQualification.label": "Staplerschein",
    });
    expect(Object.keys(values)).not.toContain("assessment.health.text");
    expect(tables.sessions!.map((row) => row.date)).toEqual(["2091-02-20", "2091-03-02"]);
    expect(tables.work!.map((row) => row.activity)).toEqual(["Schichtleiterin", "Lageristin"]);
    expect(tables.education![0]).toMatchObject({
      institution: "Berufsschule Nord",
      completed: "yes",
    });
    expect(tables.languages).toEqual([
      { language: "Polnisch", level: "business_fluent" },
      { language: "Rumänisch (ș, ț)", level: "basic" },
    ]);
  });

  it("lists the marked highest school qualification first, never one inferred (Q196)", () => {
    const [school, vocational] = syntheticTl407.profile.educationHistory!;
    const marked = {
      ...syntheticTl407,
      profile: {
        ...syntheticTl407.profile,
        educationHistory: [vocational!, { ...school!, highestSchoolQualification: true as const }],
      },
    };
    const { tables } = tl407Input(marked);
    expect(tables.education!.map((row) => row.institution)).toEqual([
      "Gesamtschule Beispielstadt",
      "Berufsschule Nord",
    ]);
    expect(Object.keys(tables.education![0]!)).not.toContain("highestSchoolQualification");
  });

  it("leaves the beE stay blank in ta_only and ticks §110 (Q181)", () => {
    const { values, projectType } = tl407Input({ ...syntheticTl407, projectType: "ta_only" });
    expect(projectType).toBe("ta_only");
    expect(values).toMatchObject({
      paragraph110: true,
      paragraph111: false,
      beeFrom: null,
      beeTo: null,
    });
  });

  it("fills phone, mobile and email only under the TL 407's own BA contact declaration", () => {
    for (const baContact of [false, null]) {
      const { values } = tl407Input({
        ...syntheticTl407,
        declarations: { jobboerseChoice: null, baContact },
      });
      expect([values.phone, values.mobile, values.email, values.jobboerseChoice]).toEqual([
        null,
        null,
        null,
        null,
      ]);
    }
  });

  it("leaves blank what is missing", () => {
    const { values, tables } = tl407Input({
      ...syntheticTl407,
      identity: { firstName: "Lukas", lastName: "Brenner", birthDate: null },
      contact: { address: null, phone: null, mobile: null, privateEmail: null },
      profile: emptyProfile,
      sensitive: emptySensitive,
      unemployment: { from: null, until: null },
      sessions: [],
      declarations: { jobboerseChoice: null, baContact: null },
      assessment: null,
    });
    const blank = Object.entries(values).filter(([, value]) => value !== null && value !== false);
    expect(Object.fromEntries(blank)).toEqual({
      paragraph111: true,
      "carrier.name": "Beispiel Transfergesellschaft mbH",
      "carrier.street": "Musterstraße",
      "carrier.houseNumber": "10",
      "carrier.postalCode": "10115",
      "carrier.city": "Berlin",
      firstName: "Lukas",
      lastName: "Brenner",
      beeFrom: "2091-04-01",
      beeTo: "2092-03-31",
    });
    expect(tables).toEqual({ sessions: [], education: [], work: [], languages: [] });
  });

  it("writes German nationality, no licence, a full-time wish and a nationwide distance", () => {
    const { values } = tl407Input({
      ...syntheticTl407,
      profile: {
        ...syntheticTl407.profile,
        drivingLicence: "none",
        workingTimePreferences: {
          employmentType: "full_time",
          weeklyHours: null,
          distribution: null,
        },
        maxCommuteDistance: { kind: "nationwide" },
      },
      sensitive: { ...syntheticTl407.sensitive, nationality: { kind: "german" } },
    });
    expect(values).toMatchObject({
      nationality: "german",
      otherNationality: null,
      drivingLicence: "keine",
      employmentType: "full_time",
      weeklyHours: null,
      workingTimeDistribution: null,
      maxDistanceKm: null,
      maxDistanceScope: "nationwide",
    });
  });
});

const split = (street: string) => {
  const { street: name, houseNumber } = splitStreet(street);
  return [name, houseNumber];
};

describe("splitStreet", () => {
  it("splits a trailing house number or range, spaced or not", () => {
    expect(split("Musterstraße 10")).toEqual(["Musterstraße", "10"]);
    expect(split("Musterstraße 12a")).toEqual(["Musterstraße", "12a"]);
    expect(split("Musterstraße 12 a")).toEqual(["Musterstraße", "12 a"]);
    expect(split("Am Ring 12-14")).toEqual(["Am Ring", "12-14"]);
    expect(split("Musterstraße 12 - 14")).toEqual(["Musterstraße", "12 - 14"]);
    expect(split("Hof 3/4b")).toEqual(["Hof", "3/4b"]);
    expect(split("Hof 3 / 4b")).toEqual(["Hof", "3 / 4b"]);
  });

  it("keeps digits inside the street name", () => {
    expect(split("Straße des 17. Juni 12a")).toEqual(["Straße des 17. Juni", "12a"]);
    expect(split("Straße des 17. Juni 5 a")).toEqual(["Straße des 17. Juni", "5 a"]);
    expect(split("B 27 Nord 4")).toEqual(["B 27 Nord", "4"]);
  });

  it("keeps an ambiguous or number-less street whole, the number blank", () => {
    for (const street of ["Am Markt", "12", "Weg 7 12", "Musterstraße 12 -", "Musterstraße 12-"]) {
      expect(split(street)).toEqual([street, null]);
    }
  });
});

describe("kug200bInput (ba-forms.md, what is filled)", () => {
  it("fills 1–12 and never the contact data, declarations, place or date", () => {
    expect(kug200bInput(syntheticKug200b)).toEqual({
      formCode: "kug200b",
      projectType: "ta_tg",
      values: {
        tgName: "Beispiel Transfergesellschaft mbH",
        employerName: "Fußball Bund Beispiel GmbH",
        firstName: "Łucja Ayşe",
        lastName: "Doğan-Großmann",
        street: "Weißdornweg",
        houseNumber: "7b",
        postalCode: "12345",
        city: "Beispielstadt",
        maritalStatus: "married",
        nationality: "other",
        otherNationality: "Polen",
        pensionInsuranceNumber: "12290751D123",
        severeDisability: "no",
      },
      tables: {},
    });
  });

  it("leaves missing data blank for the participant", () => {
    const { values } = kug200bInput({
      ...syntheticKug200b,
      customerName: null,
      address: null,
      maritalStatus: null,
      sensitive: { nationality: null, pensionInsuranceNumber: null, severeDisability: true },
    });
    expect(values).toMatchObject({
      employerName: null,
      street: null,
      houseNumber: null,
      postalCode: null,
      city: null,
      maritalStatus: null,
      nationality: null,
      pensionInsuranceNumber: null,
      severeDisability: "yes",
    });
  });
});
