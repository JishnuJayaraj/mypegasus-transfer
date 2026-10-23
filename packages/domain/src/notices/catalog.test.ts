// Tests may use Node; the domain package deliberately exposes no Node types to production code.
// @ts-expect-error node types are intentionally absent from this package's tsconfig
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ART14_NOTICE_VERSION,
  PORTAL_CONTACT_CONSENT_V1,
  PORTAL_CONTACT_CONSENT_VERSION,
  PORTAL_APPOINTMENT_CHANGE_VERSION,
  PORTAL_INVITATION_VERSION,
  PORTAL_REMINDER_VERSION,
  appointmentChangeTemplates,
  invitationTemplates,
  messageFor,
  messageTemplates,
  messageVersionOf,
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

const joined = ({
  subject,
  text,
  emailNote,
}: {
  subject: string;
  text: string;
  emailNote: string;
}) => [subject, text, emailNote].join("\n\n");

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

describe("the invitation and notice texts (data-protection.md, messages: the texts; Q165)", () => {
  const url = "https://portal.example.invalid/portal/";

  it("are immutable in both languages", () => {
    expect(
      [invitationTemplates, appointmentChangeTemplates].flatMap((templates) =>
        Object.values(templates).map(({ version, language, sha256 }) => [
          version,
          language,
          sha256,
        ]),
      ),
    ).toEqual([
      [
        PORTAL_INVITATION_VERSION,
        "de",
        "eb943dadcf095d7dbae766af4a742c6c7f4bfc2e171870c346990c318bffa7e1",
      ],
      [
        PORTAL_INVITATION_VERSION,
        "en",
        "b70e188eab5b0b8421f8462236bc1a2c390a5e5f705ed09bc37551a7c75079ed",
      ],
      [
        PORTAL_APPOINTMENT_CHANGE_VERSION,
        "de",
        "1a6efbe9df14fa995489503c1c3cf5825e7bd7643b8be7e55dd3f2c6ebdc9f71",
      ],
      [
        PORTAL_APPOINTMENT_CHANGE_VERSION,
        "en",
        "ca5e9a63d88a3e4230dfd5b1bfa84a9772391d6551be51f36806423e8878f3f8",
      ],
    ]);
    for (const template of [
      ...Object.values(invitationTemplates),
      ...Object.values(appointmentChangeTemplates),
    ]) {
      expect(createHash("sha256").update(joined(template)).digest("hex")).toBe(template.sha256);
      expect(joined(template).match(/\{\{[^}]*\}\}/g)).toEqual(["{{portalUrl}}"]);
    }
  });

  it("go with their kinds: one text for both notices", () => {
    expect(messageVersionOf("open_items")).toBe(PORTAL_REMINDER_VERSION);
    expect(messageVersionOf("appointment_invitation")).toBe("portal-invitation:v1");
    expect(messageVersionOf("appointment_changed")).toBe("portal-appointment-change:v1");
    expect(messageVersionOf("appointment_cancelled")).toBe("portal-appointment-change:v1");
    expect(messageFor("open_items", "de", "sms", url)).toEqual(reminderMessage("de", "sms", url));
  });

  it("go out as plain text: the note by email only", () => {
    expect(messageFor("appointment_invitation", "de", "email", url)).toEqual({
      subject: "Neue Einladung im Teilnehmerportal",
      text:
        `In Ihrem Teilnehmerportal gibt es eine Einladung zu einem Termin. Bitte melden Sie sich an: ${url}\n\n` +
        "Diese Nachricht enthält aus Datenschutzgründen keine weiteren Einzelheiten.",
    });
    expect(messageFor("appointment_cancelled", "en", "sms", url)).toEqual({
      text: `One of your appointments in the participant portal has changed. Please sign in: ${url}`,
    });
  });

  it("contain nothing beyond the fixed text but the portal URL", () => {
    const kinds = [
      "open_items",
      "appointment_invitation",
      "appointment_changed",
      "appointment_cancelled",
    ] as const;
    for (const kind of kinds) {
      for (const language of ["de", "en"] as const) {
        const template = messageTemplates[kind][language];
        for (const channel of ["email", "sms"] as const) {
          const message = messageFor(kind, language, channel, url);
          const fixed = template.text.replace("{{portalUrl}}", url);
          expect(message.text).toBe(
            channel === "email" ? `${fixed}\n\n${template.emailNote}` : fixed,
          );
          expect(message.subject).toBe(channel === "email" ? template.subject : undefined);
          expect(message.text.replace(url, "")).toBe(
            channel === "email"
              ? `${template.text.replace("{{portalUrl}}", "")}\n\n${template.emailNote}`
              : template.text.replace("{{portalUrl}}", ""),
          );
        }
      }
    }
  });
});
