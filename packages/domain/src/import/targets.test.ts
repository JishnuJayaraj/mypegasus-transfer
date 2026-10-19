import { describe, expect, it } from "vitest";
import {
  checkMapping,
  headerLooksLikeData,
  ImportTarget,
  isRequired,
  normaliseCountry,
  normaliseHeader,
  suggestTargets,
} from "./targets";

// Slice 2 plan 5.11 (AC-23; round 32): the mapping and its suggestions.
const none = new Set<string>();
const relaxed = new Set([
  "base-import-birthDate",
  "base-import-oldEmploymentEndDate",
  "base-import-address",
]);
const full: ImportTarget[] = [
  "personnelNumber",
  "lastName",
  "firstName",
  "birthDate",
  "oldEmploymentEndDate",
  "addressStreet",
  "addressPostalCode",
  "addressCity",
];
const codes = (targets: ImportTarget[], country: string | null, relaxedRuleIds = none) =>
  checkMapping({ targets, relaxedRuleIds, country }).map((i) => `${i.target}:${i.code}`);

describe("isRequired (R6, Q75)", () => {
  it("always requires the match key and the names; the rest unless relaxed", () => {
    for (const target of ["personnelNumber", "lastName", "firstName"] as const) {
      expect(isRequired(target, relaxed)).toBe(true);
    }
    for (const target of ["birthDate", "oldEmploymentEndDate", "address"] as const) {
      expect(isRequired(target, none)).toBe(true);
      expect(isRequired(target, relaxed)).toBe(false);
    }
  });
});

describe("normaliseCountry (round 32)", () => {
  it("accepts Germany's spellings, trimmed and case-insensitive, and nothing else", () => {
    for (const value of ["DE", " de ", "DEU", "Deutschland", "GERMANY"]) {
      expect(normaliseCountry(value)).toBe("DE");
    }
    for (const value of ["AT", "Österreich", "D", ""]) expect(normaliseCountry(value)).toBeNull();
  });
});

describe("checkMapping (5.11, AC-23)", () => {
  it("accepts a complete mapping with a country column or a selected country", () => {
    expect(codes([...full, "addressCountry"], null)).toEqual([]);
    expect(codes(full, "Deutschland")).toEqual([]);
  });

  it("refuses a target mapped twice and missing required targets, without a row", () => {
    expect(
      checkMapping({ targets: [...full, "lastName"], relaxedRuleIds: none, country: "DE" }),
    ).toEqual([{ row: null, target: "lastName", code: "target_mapped_twice", severity: "error" }]);
    expect(codes([], null)).toEqual([
      "personnelNumber:required_missing",
      "lastName:required_missing",
      "firstName:required_missing",
      "birthDate:required_missing",
      "oldEmploymentEndDate:required_missing",
      "address:required_missing",
    ]);
  });

  it("lets a relaxed rule leave its target unmapped, never the match key or the names", () => {
    expect(codes(["personnelNumber", "lastName", "firstName"], null, relaxed)).toEqual([]);
    expect(codes(["lastName", "firstName"], null, relaxed)).toEqual([
      "personnelNumber:required_missing",
    ]);
  });

  it("needs the address parts all or none", () => {
    const partial = full.filter((t) => t !== "addressCity");
    expect(codes(partial, "DE")).toEqual(["address:address_incomplete"]);
    expect(codes(partial, "DE", relaxed)).toEqual(["address:address_incomplete"]);
    // The country is part of the unit (review of PR #44): mapped alone it is incomplete too.
    const key = ["personnelNumber", "lastName", "firstName"] as ImportTarget[];
    expect(codes([...key, "addressCountry"], null, relaxed)).toEqual([
      "address:address_incomplete",
    ]);
    expect(codes([...full.slice(0, 5), "addressCountry"], null)).toEqual([
      "address:address_incomplete",
    ]);
  });

  it("needs exactly one country source, and a selected country must be Germany", () => {
    expect(codes(full, null)).toEqual(["addressCountry:country_required"]);
    expect(codes([...full, "addressCountry"], "DE")).toEqual([
      "addressCountry:country_source_conflict",
    ]);
    expect(codes(full, "Österreich")).toEqual(["addressCountry:foreign_address_unsupported"]);
    // A selected country without an address mapped is no conflict and needs no column.
    expect(codes(["personnelNumber", "lastName", "firstName"], "DE", relaxed)).toEqual([]);
  });
});

describe("suggestTargets (round 32)", () => {
  it("normalises case, punctuation and spacing", () => {
    expect(normaliseHeader(" Pers.-Nr. ")).toBe("persnr");
    expect(normaliseHeader("E-Mail (privat)")).toBe("emailprivat");
  });

  it("suggests each target for the first matching column only, and never for Anschrift", () => {
    const headers = ["PERS-NR", "Name", "Vorname(n)", "Geb.-Datum", "Anschrift", "PLZ", "Ort"];
    expect(
      suggestTargets([...headers, "Wohnort", "Strasse/Hausnummer", "Handy", "Steuer-ID"]),
    ).toEqual([
      "personnelNumber",
      "lastName",
      "firstName",
      "birthDate",
      null,
      "addressPostalCode",
      "addressCity",
      null,
      "addressStreet",
      "mobile",
      null,
    ]);
  });

  it("knows the remaining targets' headers", () => {
    expect(
      suggestTargets(["Austrittsdatum", "Ländercode", "Telefon", "E-Mail privat", "Firmen-E-Mail"]),
    ).toEqual(["oldEmploymentEndDate", "addressCountry", "phone", "privateEmail", "workEmail"]);
  });
});

describe("headerLooksLikeData (R44, round 33)", () => {
  it("passes real header rows, synonyms and free headings alike", () => {
    expect(headerLooksLikeData(["Personalnummer", "Nachname", "Vorname", "Geb.-Datum"])).toBe(
      false,
    );
    expect(headerLooksLikeData(["Pers.-Nr.", "PLZ", "E-Mail privat", "Kostenstelle 4711"])).toBe(
      false,
    );
    expect(headerLooksLikeData([])).toBe(false);
  });

  it("flags a row with a date, an @ or five or more digits in a cell", () => {
    expect(headerLooksLikeData(["BSP-0001", "Mustermann", "01.01.1970"])).toBe(true);
    expect(headerLooksLikeData(["Mustermann", "1970-01-01"])).toBe(true);
    expect(headerLooksLikeData(["Erika", "erika@example.org"])).toBe(true);
    expect(headerLooksLikeData(["Musterstraße 1", "99999"])).toBe(true);
    expect(headerLooksLikeData(["Telefon", "030 23125 000"])).toBe(true);
    expect(headerLooksLikeData(["Spalte 1234"])).toBe(false);
  });
});
