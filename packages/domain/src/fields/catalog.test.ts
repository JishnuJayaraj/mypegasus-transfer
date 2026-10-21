import { describe, expect, it } from "vitest";
import { EndReason, ProfilingExceptionReason } from "../lifecycle/enums";
import {
  AccessCategory,
  fieldCatalog,
  fieldEntry,
  isListable,
  ParticipantDataField,
  valueDataClass,
} from "./catalog";

const sensitive = new Set(["special_category", "highly_confidential"]);
const retention = (key: string) => fieldEntry(key).retentionClass;

// Which data classes a field of each access category may hold (data-protection.md).
// Signed documents, audit metadata and aggregates are not participant fields.
const classesByCategory: Partial<Record<AccessCategory, string[]>> = {
  case_internal: ["internal"],
  confidential: ["confidential"],
  health: ["special_category"],
  disability: ["special_category"],
  identifiers: ["highly_confidential"],
  residence_social: ["highly_confidential"],
  profiling_assessment: ["highly_confidential", "special_category"],
  absence: ["confidential"],
};

describe("field catalog (AC-29)", () => {
  it("has unique camelCase keys", () => {
    const keys = fieldCatalog.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z][a-zA-Z0-9]*$/);
  });

  it.each(fieldCatalog.map((f) => [f.key, f] as const))("%s: class fits its category", (_, f) => {
    expect(classesByCategory[f.accessCategory] ?? []).toContain(f.dataClass);
  });

  it("never lists or stores in plain columns special-category or highly confidential fields", () => {
    const listedSensitive = fieldCatalog.filter((f) => sensitive.has(f.dataClass) && f.listable);
    expect(listedSensitive).toEqual([]);
    const encrypted = fieldCatalog.filter((f) => f.storage === "encrypted_column");
    expect(encrypted).toEqual(fieldCatalog.filter((f) => sensitive.has(f.dataClass)));
  });

  it("marks exactly the customer whitelist as customer-visible (provisional, Q13)", () => {
    const visible = fieldCatalog.filter((f) => f.customerVisible).map((f) => f.key);
    const whitelist = ["firstName", "lastName", "personnelNumber", "dsvSignedOn"];
    expect(visible.toSorted()).toEqual([...whitelist, "tgEntryDate", "exitDate"].toSorted());
  });

  it("lets participants write no status, date set by the system or section C (Q65)", () => {
    const staffOnly = new Set(["case_internal", "profiling_assessment", "absence"]);
    const writable = fieldCatalog.filter((f) => staffOnly.has(f.accessCategory) && f.selfService);
    expect(writable).toEqual([]);
  });

  it.each([
    ["maritalStatus", "confidential"],
    ["gender", "confidential"],
    ["personnelNumber", "confidential"],
    ["oldEmploymentEndDate", "confidential"],
    ["knowledgeDate", "confidential"],
    ["workEmail", "confidential"],
    ["languageSkills", "confidential"],
    ["drivingLicence", "confidential"],
    ["nationality", "highly_confidential"],
    ["buergergeld", "highly_confidential"],
    ["profilingHealthAssessment", "special_category"],
    ["severeDisability", "special_category"],
    // Q85: not classified by the docs, the stricter class of its form section until answered
    ["unemploymentPeriod", "highly_confidential"],
  ])("classifies %s as %s (Q29, Q43, Q66)", (key, dataClass) => {
    expect(fieldEntry(key).dataClass).toBe(dataClass);
  });

  it("keeps identity in the participation record and the rest in the personnel file (Q105)", () => {
    const identity = ["personnelNumber", "lastName", "firstName", "birthDate"];
    for (const key of ParticipantDataField.options) {
      expect(retention(key)).toBe(
        identity.includes(key) ? "participation_record" : "personnel_file",
      );
      expect(fieldEntry(key)).toMatchObject({ dataClass: "confidential", storage: "column" });
    }
    for (const key of ["tgEnd", "endReason", "profilingExceptionReasonCode"]) {
      expect(retention(key)).toBe("participation_record");
    }
    expect(retention("qualifications")).toBeUndefined();
  });

  it("classifies every self-service field the wizard collects (Q141)", () => {
    const personnelFile = [
      "gender",
      "maritalStatus",
      "educationHistory",
      "workHistory",
      "languageSkills",
      "drivingLicence",
      "vehicleAvailable",
      "workingTimePreferences",
      "jobWishes",
      "desiredWorkLocations",
      "maxCommuteDistance",
      "earliestStartDate",
      "nationality",
      "entryToGermanyDate",
      "residenceStatus",
      "buergergeld",
    ];
    for (const key of personnelFile) {
      expect([key, retention(key), fieldEntry(key).selfService]).toEqual([
        key,
        "personnel_file",
        true,
      ]);
    }
    expect(retention("pensionInsuranceNumber")).toBe("participation_record");
    expect(retention("healthRestrictions")).toBe("health_record");
    expect(retention("severeDisability")).toBe("health_record");
  });

  it("rejects an unknown field key", () => {
    expect(() => fieldEntry("custom.unknown")).toThrow("Unknown field custom.unknown");
  });
});

describe("classification per value (Q66, Q81)", () => {
  it("makes only the health-related end reason special category", () => {
    for (const reason of EndReason.options) {
      const expected =
        reason === "long_term_illness_reduced_earning_capacity"
          ? "special_category"
          : "confidential";
      expect([reason, valueDataClass("endReason", reason)]).toEqual([reason, expected]);
    }
  });

  it("never lists the health-related end reason, but lists the others", () => {
    expect(isListable("endReason", "long_term_illness_reduced_earning_capacity")).toBe(false);
    expect(isListable("endReason", "deceased")).toBe(true);
    expect(isListable("endReason")).toBe(true);
  });

  it("keeps exception reason codes confidential", () => {
    for (const code of ProfilingExceptionReason.options) {
      expect(valueDataClass("profilingExceptionReasonCode", code)).toBe("confidential");
    }
  });

  it("follows the field for unlisted fields", () => {
    expect(isListable("iban")).toBe(false);
    expect(isListable("status", "informed")).toBe(true);
  });
});
