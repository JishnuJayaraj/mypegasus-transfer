import type { Kug200bSource, Tl407Assessment, Tl407Source } from "../input";

// Synthetic people only (CLAUDE.md, rule 1): fictional names, addresses and numbers, with the
// characters outside WinAnsi the forms must print (`Ł`, `ğ`, `ș`) and `ß`.

const line = (text: string | null) => ({ rating: "placement_relevant" as const, text });

export const syntheticAssessment: Tl407Assessment = {
  schoolQualification: { rating: "no_need", text: null },
  vocationalQualification: line("Fortbildung Lagerlogistik prüfen"),
  workExperience: { rating: "no_need", text: null },
  languageSkills: line("Deutschkurs B2 für den Beruf"),
  otherQualification: { rating: "no_need", text: null, label: "Staplerschein" },
  health: { rating: "no_need" },
  intellectualCapacity: { rating: "no_need", text: null },
  workAndSocialBehaviour: { rating: "no_need", text: null },
  otherPerformance: { rating: null, text: null, label: null },
  initiative: { rating: "no_need", text: null },
  learningReadiness: { rating: "no_need", text: null },
  otherMotivation: { rating: null, text: null, label: null },
  localMobility: line("Umzug in die Region Süd möglich"),
  otherConditions: { rating: null, text: null, label: null },
  overallAssessment: "Motivierter Beschäftigter mit langjähriger Erfahrung in der Logistik.",
  nextSteps: "Bewerbungstraining; Qualifizierung zur Fachkraft für Lagerlogistik.",
};

export const syntheticTl407: Tl407Source = {
  projectType: "ta_tg",
  today: "2091-03-01",
  transferCompany: {
    name: "Beispiel Transfergesellschaft mbH",
    street: "Musterstraße",
    houseNumber: "10",
    postalCode: "10115",
    city: "Berlin",
  },
  identity: { firstName: "Łucja Ayşe", lastName: "Doğan-Großmann", birthDate: "2051-07-29" },
  tgStart: "2091-04-01",
  tgEnd: "2092-03-31",
  contact: {
    address: {
      street: "Weißdornweg 7b",
      postalCode: "12345",
      city: "Beispielstadt",
      country: "DE",
    },
    phone: "030 1234567",
    mobile: "0151 2345678",
    privateEmail: "lucja.dogan@example.org",
  },
  profile: {
    gender: "female",
    maritalStatus: "married",
    educationHistory: [
      {
        from: "2058-08-01",
        to: "2068-07-15",
        institution: "Gesamtschule Beispielstadt",
        qualification: "Mittlere Reife",
        completed: true,
      },
      {
        from: "2068-09-01",
        to: "2071-06-30",
        institution: "Berufsschule Nord",
        qualification: "Fachkraft für Lagerlogistik",
        completed: true,
      },
    ],
    workHistory: [
      {
        from: "2071-07-01",
        to: "2089-12-31",
        employer: "Werk Nord GmbH, Beispielstadt",
        activity: "Lageristin",
      },
      {
        from: "2090-01-01",
        to: null,
        employer: "Lager Süd AG, Beispielstadt",
        activity: "Schichtleiterin",
      },
    ],
    languageSkills: {
      german: "business_fluent",
      others: [
        { language: "Polnisch", level: "business_fluent" },
        { language: "Rumänisch (ș, ț)", level: "basic" },
      ],
    },
    drivingLicence: ["B", "C1"],
    vehicleAvailable: true,
    workingTimePreferences: {
      employmentType: "part_time",
      weeklyHours: 30.5,
      distribution: "Frühschicht, Montag bis Freitag",
    },
    jobWishes: { desired: "Fachkraft für Lagerlogistik", alternative: "Disponentin" },
    desiredWorkLocations: "Beispielstadt und Umgebung",
    maxCommuteDistance: { kind: "km", km: 50 },
    earliestStartDate: "2091-05-01",
  },
  sensitive: {
    pensionInsuranceNumber: "12290751D123",
    nationality: { kind: "other", country: "PL" },
    entryToGermanyDate: "2055-01-15",
    residenceStatus: "settlement_permit",
    buergergeld: false,
    healthRestrictions: false,
    severeDisability: false,
  },
  unemployment: { from: "2091-04-01", until: null },
  sessions: [
    { date: "2091-03-02", from: "13:00", to: "15:30" },
    { date: "2091-02-20", from: "09:00", to: "11:00" },
  ],
  declarations: { jobboerseChoice: "anonymous_callme", baContact: true },
  assessment: syntheticAssessment,
};

export const syntheticKug200b: Kug200bSource = {
  transferCompany: syntheticTl407.transferCompany,
  customerName: "Fußball Bund Beispiel GmbH",
  identity: { firstName: "Łucja Ayşe", lastName: "Doğan-Großmann" },
  address: syntheticTl407.contact.address,
  maritalStatus: "married",
  sensitive: {
    nationality: { kind: "other", country: "PL" },
    pensionInsuranceNumber: "12290751D123",
    severeDisability: false,
  },
};
