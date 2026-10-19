import { describe, expect, it } from "vitest";
import { checkManualCreation, ManualParticipationInput, type ManualValues } from "./manual";
import type { ExistingParticipant } from "./plan";

// Slice 2 plan, "Planned in PR 2h" (PR 2h-2; R32, AC-51): manual creation is one import row,
// with the differences R32 names.

const today = "2026-10-19";
const none = new Set<string>();
const relaxedAll = new Set([
  "base-import-birthDate",
  "base-import-oldEmploymentEndDate",
  "base-import-address",
]);
const complete: ManualValues = {
  personnelNumber: " BSP-0100 ",
  lastName: "Beispiel",
  firstName: "Bernd",
  birthDate: "01.01.1970",
  oldEmploymentEndDate: "31.12.2026",
  addressStreet: "Musterstraße 1",
  addressPostalCode: "99999",
  addressCity: "Beispielstadt",
  mobile: "0171 3920000",
};
const existing: ExistingParticipant[] = [
  {
    participationId: "p-1",
    terminal: false,
    values: {
      personnelNumber: "BSP-0001",
      lastName: "Mustermann",
      firstName: "Erika",
      birthDate: "1970-01-01",
    },
  },
  { participationId: "p-2", terminal: true, values: { personnelNumber: "BSP-0002" } },
];
const check = (values: ManualValues, extra: object = {}) =>
  checkManualCreation({
    values,
    existing,
    relaxedRuleIds: none,
    today,
    confirmWarnings: false,
    createDespiteDuplicate: false,
    ...extra,
  });

describe("checkManualCreation (R32)", () => {
  it("accepts a complete person and returns the values as the import stores them", () => {
    expect(check(complete)).toEqual({
      ok: true,
      values: {
        personnelNumber: "BSP-0100",
        lastName: "Beispiel",
        firstName: "Bernd",
        birthDate: "1970-01-01",
        oldEmploymentEndDate: "2026-12-31",
        addressStreet: "Musterstraße 1",
        addressPostalCode: "99999",
        addressCity: "Beispielstadt",
        addressCountry: "DE",
        mobile: "0171 3920000",
      },
      confirmedWarnings: [],
    });
  });

  it("requires what the import requires, unless relaxed", () => {
    const result = check({ personnelNumber: "BSP-0100" });
    expect(result).toEqual({
      ok: false,
      issues: [
        { target: "lastName", code: "required_missing" },
        { target: "firstName", code: "required_missing" },
        { target: "birthDate", code: "required_missing" },
        { target: "oldEmploymentEndDate", code: "required_missing" },
        { target: "address", code: "required_missing" },
      ],
    });
    expect(
      checkManualCreation({
        values: { personnelNumber: "BSP-0100", lastName: "B", firstName: "B" },
        existing,
        relaxedRuleIds: relaxedAll,
        today,
        confirmWarnings: false,
        createDespiteDuplicate: false,
      }),
    ).toMatchObject({ ok: true, values: { personnelNumber: "BSP-0100" } });
    expect(check({ ...complete, personnelNumber: "  " })).toMatchObject({
      ok: false,
      issues: [{ target: "personnelNumber", code: "required_missing" }],
    });
  });

  it("refuses an existing Personalnummer, terminal or not, naming the participation", () => {
    expect(check({ ...complete, personnelNumber: "BSP-0001" })).toEqual({
      ok: false,
      issues: [{ target: "personnelNumber", code: "personnel_number_taken" }],
      participationId: "p-1",
    });
    expect(check({ ...complete, personnelNumber: "BSP-0002" })).toMatchObject({
      participationId: "p-2",
    });
  });

  it("makes a value the import would drop a field error (value_invalid)", () => {
    expect(check({ ...complete, phone: "12", privateEmail: "nicht-gültig" })).toEqual({
      ok: false,
      issues: [
        { target: "phone", code: "value_invalid" },
        { target: "privateEmail", code: "value_invalid" },
      ],
    });
  });

  it("reports the row's errors at their fields", () => {
    expect(
      check({ ...complete, birthDate: "31.02.1975", addressCity: "", addressPostalCode: "1234" }),
    ).toEqual({
      ok: false,
      issues: [
        { target: "birthDate", code: "invalid_date" },
        { target: "address", code: "address_incomplete" },
      ],
    });
  });

  it("needs the PL's confirmation for a warning, and audits it", () => {
    const young = { ...complete, birthDate: "01.01.2015" };
    expect(check(young)).toEqual({
      ok: false,
      issues: [
        { target: null, code: "warnings_unconfirmed" },
        { target: "birthDate", code: "age_implausible" },
      ],
    });
    expect(check(young, { confirmWarnings: true })).toMatchObject({
      ok: true,
      confirmedWarnings: ["age_implausible"],
    });
  });

  it("needs a decision for a possible duplicate, and audits creating it anyway", () => {
    const twin = {
      ...complete,
      lastName: " mustermann ",
      firstName: "ERIKA",
      birthDate: "01.01.1970",
    };
    expect(check(twin)).toEqual({
      ok: false,
      issues: [{ target: null, code: "possible_duplicate" }],
    });
    expect(check(twin, { createDespiteDuplicate: true })).toMatchObject({
      ok: true,
      confirmedWarnings: ["possible_duplicate"],
    });
  });

  it("checks both at once: an unconfirmed warning and an undecided duplicate", () => {
    const twinTooOld = {
      ...complete,
      lastName: "Mustermann",
      firstName: "Erika",
      birthDate: "01.01.1940",
    };
    const both = [
      {
        participationId: "p-3",
        terminal: false,
        values: {
          personnelNumber: "BSP-0003",
          lastName: "Mustermann",
          firstName: "Erika",
          birthDate: "1940-01-01",
        },
      },
    ];
    const result = checkManualCreation({
      values: twinTooOld,
      existing: both,
      relaxedRuleIds: none,
      today,
      confirmWarnings: false,
      createDespiteDuplicate: false,
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        { target: null, code: "possible_duplicate" },
        { target: null, code: "warnings_unconfirmed" },
        { target: "birthDate", code: "age_implausible" },
      ],
    });
  });
});

describe("ManualParticipationInput", () => {
  it("takes the import's targets as text, but no country (Germany only, round 32)", () => {
    expect(ManualParticipationInput.safeParse({ values: complete }).success).toBe(true);
    expect(
      ManualParticipationInput.safeParse({ values: { ...complete, addressCountry: "DE" } }).success,
    ).toBe(false);
    expect(
      ManualParticipationInput.safeParse({ values: { ...complete, lastName: "x".repeat(501) } })
        .success,
    ).toBe(false);
    expect(ManualParticipationInput.parse({ values: {} })).toEqual({
      values: {},
      confirmWarnings: false,
      createDespiteDuplicate: false,
    });
  });
});
