// Tests may use Node; the domain package deliberately exposes no Node types to production code.
// @ts-expect-error node types are intentionally absent from this package's tsconfig
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ART14_NOTICE_VERSION,
  PORTAL_CONTACT_CONSENT_VERSION,
  art14Notice,
  noticeCatalog,
  portalContactConsent,
} from "./catalog";

describe("immutable notice catalog", () => {
  it("contains German and English Art. 14 and consent texts whose released digest cannot drift", () => {
    expect(noticeCatalog.map(({ version, language }) => `${version}:${language}`)).toEqual([
      `${ART14_NOTICE_VERSION}:de`,
      `${ART14_NOTICE_VERSION}:en`,
      `${PORTAL_CONTACT_CONSENT_VERSION}:de`,
      `${PORTAL_CONTACT_CONSENT_VERSION}:en`,
    ]);
    for (const notice of noticeCatalog) {
      expect(createHash("sha256").update(notice.text).digest("hex")).toBe(notice.sha256);
    }
  });

  it("renders every controller and DPO placeholder from configuration", () => {
    const rendered = art14Notice("en", {
      controllerName: "Synthetic Controller GmbH",
      controllerAddress: "Example Street 1, 10115 Berlin",
      controllerEmail: "controller@example.invalid",
      dpoName: "Synthetic DPO",
      dpoAddress: "Privacy Street 2, 10115 Berlin",
      dpoEmail: "privacy@example.invalid",
    });
    expect(rendered.text).not.toContain("{{");
    expect(rendered.text).toContain("Synthetic Controller GmbH");
    expect(rendered.text).toContain("privacy@example.invalid");
  });

  it("renders the consent text with the controller's name and contact (D28)", () => {
    const organisation = {
      controllerName: "Synthetic Controller GmbH",
      controllerAddress: "Example Street 1, 10115 Berlin",
      controllerEmail: "controller@example.invalid",
      dpoName: "Synthetic DPO",
      dpoAddress: "Privacy Street 2, 10115 Berlin",
      dpoEmail: "privacy@example.invalid",
    };
    for (const language of ["de", "en"] as const) {
      const consent = portalContactConsent(language, organisation);
      expect(consent.version).toBe(PORTAL_CONTACT_CONSENT_VERSION);
      expect(consent.text).not.toContain("{{");
      expect(consent.text).toContain("controller@example.invalid");
    }
  });
});
