// Tests may use Node; the domain package deliberately exposes no Node types to production code.
// @ts-expect-error node types are intentionally absent from this package's tsconfig
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ART14_NOTICE_VERSION,
  PORTAL_CONTACT_CONSENT_V1,
  PORTAL_CONTACT_CONSENT_VERSION,
  PORTAL_REMINDER_VERSION,
  reminderConsentVersion,
  reminderMessage,
  reminderTemplates,
  SELF_SERVICE_NOTICE_VERSION,
  art14Notice,
  noticeCatalog,
  portalContactConsent,
  selfServicePurposesNotice,
} from "./catalog";

describe("immutable notice catalog", () => {
  it("contains German and English Art. 14 and consent texts whose released digest cannot drift", () => {
    expect(noticeCatalog.map(({ version, language }) => `${version}:${language}`)).toEqual([
      `${ART14_NOTICE_VERSION}:de`,
      `${ART14_NOTICE_VERSION}:en`,
      `${PORTAL_CONTACT_CONSENT_V1}:de`,
      `${PORTAL_CONTACT_CONSENT_V1}:en`,
      `${SELF_SERVICE_NOTICE_VERSION}:de`,
      `${SELF_SERVICE_NOTICE_VERSION}:en`,
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

  it("renders the self-service purposes notice, an acknowledgement (Q138)", () => {
    const organisation = {
      controllerName: "Synthetic Controller GmbH",
      controllerAddress: "Example Street 1, 10115 Berlin",
      controllerEmail: "controller@example.invalid",
      dpoName: "Synthetic DPO",
      dpoAddress: "Privacy Street 2, 10115 Berlin",
      dpoEmail: "privacy@example.invalid",
    };
    for (const language of ["de", "en"] as const) {
      const notice = selfServicePurposesNotice(language, organisation);
      expect(notice.version).toBe(SELF_SERVICE_NOTICE_VERSION);
      expect(notice.text).not.toContain("{{");
      expect(notice.text).toContain("Synthetic Controller GmbH");
      expect(notice.text).toMatch(/9\(2\)\(b\)|9 Abs\. 2 Buchst\. b/);
    }
  });

  it("records consent v2 for new channels and keeps v1 as evidence (data-protection.md, consent v2)", () => {
    expect(PORTAL_CONTACT_CONSENT_V1).toBe("portal-contact-consent:v1");
    expect(PORTAL_CONTACT_CONSENT_VERSION).toBe("portal-contact-consent:v2");
    expect(reminderConsentVersion).toBe(PORTAL_CONTACT_CONSENT_VERSION);
    const digests = Object.fromEntries(
      noticeCatalog.map(({ version, language, sha256 }) => [`${version}:${language}`, sha256]),
    );
    expect(digests[`${PORTAL_CONTACT_CONSENT_V1}:de`]).toBe(
      "356247698c46c89c9dc2a718baaa764d567b5245eb720e0a3c511be9849a9724",
    );
    expect(digests[`${PORTAL_CONTACT_CONSENT_VERSION}:de`]).toBe(
      "1551a38f2fd27b03d521a740430771a2eae339eb3fac0ee4b9409ddece294d7f",
    );
    expect(digests[`${PORTAL_CONTACT_CONSENT_VERSION}:en`]).toBe(
      "ae97ab9ab27f1d4be9fd38dcadfc7cbcb5223c002e476527aeb2e4b653403308",
    );
    const organisation = {
      controllerName: "Synthetic Controller GmbH",
      controllerAddress: "Example Street 1, 10115 Berlin",
      controllerEmail: "controller@example.invalid",
      dpoName: "Synthetic DPO",
      dpoAddress: "Privacy Street 2, 10115 Berlin",
      dpoEmail: "privacy@example.invalid",
    };
    expect(portalContactConsent("de", organisation).text).toContain("Erinnerung");
    expect(portalContactConsent("en", organisation).text).toContain("never used for advertising");
  });
});

const joined = ({ subject, text, emailNote }: (typeof reminderTemplates)["de"]) =>
  [subject, text, emailNote].join("\n\n");

describe("the reminder text (data-protection.md, reminders; Q154)", () => {
  it("is immutable in both languages", () => {
    expect(
      Object.values(reminderTemplates).map(({ version, language, sha256 }) => [
        version,
        language,
        sha256,
      ]),
    ).toEqual([
      [
        PORTAL_REMINDER_VERSION,
        "de",
        "6c179e836430938b1333586603061c8857d84a9d1aae5daad5d9a00e541cc61c",
      ],
      [
        PORTAL_REMINDER_VERSION,
        "en",
        "ee71cfb6dd4f9dbc5cce04d02401274a8bb0b37dc140ef1f095a2f62f01f658c",
      ],
    ]);
    for (const template of Object.values(reminderTemplates)) {
      expect(createHash("sha256").update(joined(template)).digest("hex")).toBe(template.sha256);
    }
  });

  it("has the portal URL as its only placeholder", () => {
    for (const template of Object.values(reminderTemplates)) {
      expect(joined(template).match(/\{\{[^}]*\}\}/g)).toEqual(["{{portalUrl}}"]);
    }
  });

  it("goes out as plain text with the URL as given: the note by email only", () => {
    const url = "https://portal.example.invalid/portal/";
    expect(reminderMessage("de", "email", url)).toEqual({
      subject: "Im Teilnehmerportal ist noch etwas offen",
      text:
        "In Ihrem Teilnehmerportal ist noch etwas offen. Bitte melden Sie sich an und prüfen Sie " +
        `Ihre Angaben oder Unterlagen: ${url}\n\n` +
        "Diese Nachricht enthält aus Datenschutzgründen keine weiteren Einzelheiten.",
    });
    expect(reminderMessage("en", "sms", url)).toEqual({
      text:
        "Something is still open in your participant portal. Please sign in and review your " +
        `information or documents: ${url}`,
    });
  });
});
