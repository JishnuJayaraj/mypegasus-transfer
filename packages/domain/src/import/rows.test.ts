import { describe, expect, it } from "vitest";
import { parseGermanDate, validateRow, type ImportCell, type RowInput } from "./rows";
import type { ImportTarget } from "./targets";

// Slice 2 plan 5.11 (AC-24; R6, R23, R24; round 32): row validation truth tables. Synthetic
// placeholder values only (D8).
const today = "2026-10-19";
const none = new Set<string>();
const relaxed = new Set([
  "base-import-birthDate",
  "base-import-oldEmploymentEndDate",
  "base-import-address",
]);
const base: Partial<Record<ImportTarget, ImportCell | null>> = {
  personnelNumber: " BSP-0001 ",
  lastName: "Mustermann",
  firstName: "Erika",
  birthDate: "01.02.1970",
  oldEmploymentEndDate: "31.03.2027",
  addressStreet: "Musterstraße 1",
  addressPostalCode: "99999",
  addressCity: "Beispielstadt",
};

const validate = (cells: RowInput["cells"], options: Partial<RowInput> = {}) =>
  validateRow({ row: 2, cells, relaxedRuleIds: none, country: "DE", today, ...options });
/** The issues of a row as `target:code:severity`. */
const issues = (cells: RowInput["cells"], options: Partial<RowInput> = {}) =>
  validate({ ...base, ...cells }, options).issues.map(
    (i) => `${i.target}:${i.code}${i.severity === "warning" ? ":warning" : ""}`,
  );

describe("parseGermanDate", () => {
  it("accepts TT.MM.JJJJ for real dates only", () => {
    expect(parseGermanDate("29.02.2028")).toBe("2028-02-29");
    for (const value of ["31.02.2027", "03.14.1998", "29.02.2027", "1.2.1970", "1970-02-01"]) {
      expect(parseGermanDate(value)).toBeNull();
    }
  });
});

describe("validateRow (5.11, AC-24)", () => {
  it("returns the trimmed values, ISO dates and the country as DE", () => {
    const result = validate(base);
    expect(result).toEqual({
      row: 2,
      issues: [],
      values: {
        personnelNumber: "BSP-0001",
        lastName: "Mustermann",
        firstName: "Erika",
        birthDate: "1970-02-01",
        oldEmploymentEndDate: "2027-03-31",
        addressStreet: "Musterstraße 1",
        addressPostalCode: "99999",
        addressCity: "Beispielstadt",
        addressCountry: "DE",
      },
    });
  });

  it("keeps the Personalnummer exactly: case, leading zeros, punctuation, inner spaces", () => {
    const cells = { ...base, personnelNumber: "  0042 a/7 " };
    expect(validate(cells).values.personnelNumber).toBe("0042 a/7");
  });

  it("treats empty and whitespace cells as absent", () => {
    expect(issues({ lastName: "   ", firstName: null })).toEqual([
      "lastName:required_missing",
      "firstName:required_missing",
    ]);
    expect(issues({ personnelNumber: "" })).toEqual(["personnelNumber:required_missing"]);
  });

  it("refuses control characters and values over the length limits", () => {
    expect(issues({ lastName: "Muster\u0007mann", addressCity: "Ort\nzwei" })).toEqual([
      "lastName:control_characters",
      "addressCity:control_characters",
    ]);
    expect(issues({ lastName: "x".repeat(100), personnelNumber: "1".repeat(50) })).toEqual([]);
    expect(
      issues({
        lastName: "x".repeat(101),
        firstName: "x".repeat(101),
        personnelNumber: "1".repeat(51),
        addressStreet: "x".repeat(201),
      }),
    ).toEqual([
      "personnelNumber:too_long",
      "lastName:too_long",
      "firstName:too_long",
      "addressStreet:too_long",
    ]);
  });

  describe("dates", () => {
    it("accepts text TT.MM.JJJJ strictly and real date cells", () => {
      expect(issues({ birthDate: "29.02.1972" })).toEqual([]);
      for (const birthDate of ["31.02.1975", "03.14.1998", "29.02.1971", "1970-02-01"]) {
        expect(issues({ birthDate })).toEqual(["birthDate:invalid_date"]);
      }
      expect(validate({ ...base, birthDate: { date: "1970-02-01" } }).values.birthDate).toBe(
        "1970-02-01",
      );
      expect(issues({ birthDate: { date: "1970-02-31" } })).toEqual(["birthDate:invalid_date"]);
    });

    it("refuses a date cell with a time and a numeric cell", () => {
      expect(issues({ oldEmploymentEndDate: { date: "2027-03-31", time: true } })).toEqual([
        "oldEmploymentEndDate:date_has_time",
      ]);
      expect(issues({ birthDate: { number: "25600" } })).toEqual(["birthDate:invalid_cell_type"]);
    });

    it("refuses a birth date after today and an Austrittsdatum before the birth date", () => {
      expect(
        issues(
          { birthDate: "19.10.2026", oldEmploymentEndDate: null },
          { relaxedRuleIds: relaxed },
        ),
      ).toEqual([]);
      expect(issues({ birthDate: "20.10.2026" })).toEqual(["birthDate:birth_date_in_future"]);
      expect(issues({ oldEmploymentEndDate: "31.01.1970" })).toEqual([
        "oldEmploymentEndDate:end_before_birth",
      ]);
    });

    it("warns when the age at the Austrittsdatum is outside 15 to 67, never blocking", () => {
      const at = (birthDate: string) => issues({ birthDate, oldEmploymentEndDate: "31.03.2027" });
      expect(at("31.03.2012")).toEqual([]); // 15 on the day
      expect(at("01.04.2012")).toEqual(["birthDate:age_implausible:warning"]); // 14
      expect(at("01.04.1959")).toEqual([]); // 67
      expect(at("31.03.1959")).toEqual(["birthDate:age_implausible:warning"]); // 68
      // No Austrittsdatum (its rule relaxed): no age check.
      const cells = { birthDate: "01.01.2020", oldEmploymentEndDate: null };
      expect(issues(cells, { relaxedRuleIds: relaxed })).toEqual([]);
    });

    it("requires both dates unless relaxed; an invalid relaxed date is still an error", () => {
      const cells = { birthDate: null, oldEmploymentEndDate: null };
      expect(issues(cells)).toEqual([
        "birthDate:required_missing",
        "oldEmploymentEndDate:required_missing",
      ]);
      expect(issues(cells, { relaxedRuleIds: relaxed })).toEqual([]);
      expect(issues({ birthDate: "x" }, { relaxedRuleIds: relaxed })).toEqual([
        "birthDate:invalid_date",
      ]);
    });
  });

  describe("numeric cells in identifiers (R24, round 32)", () => {
    it("refuses a numeric Personalnummer", () => {
      expect(issues({ personnelNumber: { number: "4711" } })).toEqual([
        "personnelNumber:identifier_cell_numeric",
      ]);
    });

    it("converts a five-digit numeric postcode with a warning, never pads one", () => {
      const result = validate({ ...base, addressPostalCode: { number: "99999" } });
      expect(result.values.addressPostalCode).toBe("99999");
      expect(result.issues).toEqual([
        {
          row: 2,
          target: "addressPostalCode",
          code: "identifier_cell_converted",
          severity: "warning",
        },
      ]);
      for (const number of ["1067", "999999", "99999.5"]) {
        expect(issues({ addressPostalCode: { number } })).toEqual([
          "addressPostalCode:identifier_cell_numeric",
        ]);
      }
    });

    it("drops a numeric phone or mobile with a warning", () => {
      const result = validate({
        ...base,
        phone: { number: "3012345678" },
        mobile: { number: "1" },
      });
      expect(result.values.phone).toBeUndefined();
      expect(result.issues.map((i) => `${i.target}:${i.code}:${i.severity}`)).toEqual([
        "phone:identifier_cell_numeric:warning",
        "mobile:identifier_cell_numeric:warning",
      ]);
    });

    it("refuses other non-text cells in text targets", () => {
      expect(issues({ lastName: { number: "1" }, addressCity: { date: "2020-01-01" } })).toEqual([
        "lastName:invalid_cell_type",
        "addressCity:invalid_cell_type",
      ]);
    });
  });

  describe("the address as one unit (R23, round 32)", () => {
    it("refuses some but not all parts, and a country cell alone", () => {
      expect(issues({ addressCity: null })).toEqual(["address:address_incomplete"]);
      const cells = { addressStreet: null, addressPostalCode: null, addressCity: null };
      expect(issues({ ...cells, addressCountry: "DE" }, { relaxedRuleIds: relaxed })).toEqual([
        "address:address_incomplete",
      ]);
      expect(validate({ ...base, addressCity: null }).values.addressStreet).toBeUndefined();
    });

    it("needs an address unless relaxed", () => {
      const cells = { addressStreet: null, addressPostalCode: " ", addressCity: null };
      expect(issues(cells)).toEqual(["address:required_missing"]);
      expect(issues(cells, { relaxedRuleIds: relaxed })).toEqual([]);
      expect(
        validate({ ...base, ...cells }, { relaxedRuleIds: relaxed }).values,
      ).not.toHaveProperty("addressCountry");
    });

    it("takes the country from the cell, else the import's, stored as DE", () => {
      expect(
        validate({ ...base, addressCountry: "Germany" }, { country: null }).values.addressCountry,
      ).toBe("DE");
      expect(issues({ addressCountry: "AT" }, { country: null })).toEqual([
        "addressCountry:foreign_address_unsupported",
      ]);
      expect(issues({}, { country: "Österreich" })).toEqual([
        "addressCountry:foreign_address_unsupported",
      ]);
      expect(issues({ addressCountry: null }, { country: null })).toEqual([
        "addressCountry:country_required",
      ]);
    });

    it("needs a German postal code of five digits", () => {
      for (const addressPostalCode of ["9999", "999999", "D-99999", "9999a"]) {
        expect(issues({ addressPostalCode })).toEqual(["addressPostalCode:postal_code_invalid"]);
        expect(validate({ ...base, addressPostalCode }).values.addressStreet).toBeUndefined();
      }
    });

    it("drops the whole address when a part has an error", () => {
      const result = validate({ ...base, addressStreet: "x".repeat(201) });
      expect(result.issues.map((i) => i.code)).toEqual(["too_long"]);
      expect(result.values).not.toHaveProperty("addressPostalCode");
      expect(result.values).not.toHaveProperty("addressCountry");
    });
  });

  describe("optional contact values (round 32)", () => {
    it("keeps valid phone numbers and emails, phone and mobile separately", () => {
      const cells = {
        ...base,
        phone: "+49 (0) 30/123-4567",
        mobile: "0151 23456789",
        privateEmail: "erika@example.org",
        workEmail: "e.mustermann@example.org",
      };
      const { values, issues: found } = validate(cells);
      expect(found).toEqual([]);
      expect(values).toMatchObject({ phone: "+49 (0) 30/123-4567", mobile: "0151 23456789" });
    });

    it("drops an invalid one with a warning and keeps the rest of the row", () => {
      const invalid = {
        phone: "12345", // too short
        mobile: "030 1234+5", // + not first
        privateEmail: "erika@example", // no dot in the domain
        workEmail: `${"x".repeat(250)}@example.org`, // too long
      };
      const result = validate({ ...base, ...invalid });
      expect(result.issues.map((i) => `${i.target}:${i.code}:${i.severity}`)).toEqual([
        "phone:value_invalid_dropped:warning",
        "mobile:value_invalid_dropped:warning",
        "privateEmail:value_invalid_dropped:warning",
        "workEmail:value_invalid_dropped:warning",
      ]);
      expect(result.values).not.toHaveProperty("phone");
      expect(result.values.lastName).toBe("Mustermann");
      expect(
        issues({ phone: "03 0 1", mobile: "abc 12345", privateEmail: "a b@example.org" }),
      ).toEqual([
        "phone:value_invalid_dropped:warning",
        "mobile:value_invalid_dropped:warning",
        "privateEmail:value_invalid_dropped:warning",
      ]);
      for (const phone of ["1".repeat(31), "(-/-)-"]) {
        expect(issues({ phone })).toEqual(["phone:value_invalid_dropped:warning"]);
      }
      expect(
        issues({ workEmail: "a\u0000@example.org", privateEmail: { date: "2020-01-01" } }),
      ).toEqual([
        "workEmail:value_invalid_dropped:warning",
        "privateEmail:value_invalid_dropped:warning",
      ]);
    });
  });

  it("never puts a value into an issue", () => {
    const secret = "Geheim-4711";
    const result = validate({ ...base, lastName: `${secret}\u0007`, phone: secret });
    expect(JSON.stringify(result.issues)).not.toContain("Geheim");
  });
});
