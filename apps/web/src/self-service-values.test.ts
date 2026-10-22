import { describe, expect, it } from "vitest";
import { formatSelfServiceValue } from "./components/self-service-values";
import { i18n } from "./i18n";

const t = i18n.getFixedT("de", "selfService");
const format = (key: string, value: unknown) =>
  formatSelfServiceValue(key, value, (k) => t(k as never));

// The "Selbstauskunft" tab shows each value as a line of text, in German (synthetic values).
describe("formatSelfServiceValue", () => {
  it("shows codes as labels, dates as TT.MM.JJJJ and nothing as a dash", () => {
    expect(format("gender", "female")).toBe("Weiblich");
    expect(format("residenceStatus", "settlement_permit")).toBe("Niederlassungserlaubnis");
    expect(format("earliestStartDate", "2091-03-01")).toBe("01.03.2091");
    expect(format("phone", null)).toBe("—");
    expect(format("vehicleAvailable", true)).toBe("Ja");
    expect(format("buergergeld", false)).toBe("Nein");
    expect(format("pensionInsuranceNumber", "65170839J003")).toBe("65170839J003");
  });

  it("shows composite values on one line, row tables one entry per line", () => {
    expect(
      format("address", { street: "Musterweg 1", postalCode: "99999", city: "Beispielstadt" }),
    ).toBe("Musterweg 1, 99999 Beispielstadt");
    expect(
      format("educationHistory", [
        { from: "2005-09-01", to: null, institution: "Berufsschule", qualification: "Lager" },
      ]),
    ).toBe("01.09.2005 – Läuft noch: Lager, Berufsschule");
    expect(
      format("workHistory", [
        { from: "2008-01-01", to: "2020-12-31", employer: "Beispiel AG", activity: "Lager" },
      ]),
    ).toBe("01.01.2008 – 31.12.2020: Lager, Beispiel AG");
    expect(
      format("languageSkills", {
        german: "business_fluent",
        others: [{ language: "Polnisch", level: "basic" }],
      }),
    ).toBe("Deutsch: Verhandlungssicher\nPolnisch: Grundkenntnisse");
    expect(format("drivingLicence", "none")).toBe("Keinen Führerschein");
    expect(format("drivingLicence", ["B", "C1"])).toBe("B, C1");
    expect(
      format("workingTimePreferences", {
        employmentType: "part_time",
        weeklyHours: 30,
        distribution: "vormittags",
      }),
    ).toBe("Teilzeit, 30 Stunden pro Woche, vormittags");
    expect(
      format("workingTimePreferences", {
        employmentType: "full_time",
        weeklyHours: null,
        distribution: null,
      }),
    ).toBe("Vollzeit");
    expect(format("jobWishes", { desired: "Lager", alternative: null })).toBe("Lager");
    expect(format("jobWishes", { desired: "Lager", alternative: "Versand" })).toBe(
      "Lager; Alternative Tätigkeit: Versand",
    );
    expect(format("maxCommuteDistance", { kind: "km", km: 30 })).toBe("30 km");
    expect(format("maxCommuteDistance", { kind: "nationwide" })).toBe("Bundesweit");
    expect(format("nationality", { kind: "german" })).toBe("Deutsch");
    expect(format("nationality", { kind: "other", country: "PL" })).toBe("Polen");
  });
});
