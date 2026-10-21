import { z } from "zod";

export const NoticeLanguage = z.enum(["de", "en"]);
export type NoticeLanguage = z.infer<typeof NoticeLanguage>;

export const ART14_NOTICE_VERSION = "art14-activation:v1" as const;
/** The consent text of a portal contact channel (Slice 3 plan D28, Q119, Q125). */
export const PORTAL_CONTACT_CONSENT_VERSION = "portal-contact-consent:v1" as const;
export type NoticeVersion = typeof ART14_NOTICE_VERSION | typeof PORTAL_CONTACT_CONSENT_VERSION;

export interface NoticeOrganisation {
  controllerName: string;
  controllerAddress: string;
  controllerEmail: string;
  dpoName: string;
  dpoAddress: string;
  dpoEmail: string;
}

export interface NoticeTemplate {
  version: NoticeVersion;
  language: NoticeLanguage;
  title: string;
  text: string;
  sha256: string;
}

const templates: Record<NoticeLanguage, NoticeTemplate> = {
  de: {
    version: ART14_NOTICE_VERSION,
    language: "de",
    title: "Datenschutzhinweise nach Art. 14 DSGVO",
    text: `Verantwortlicher: {{controllerName}}, {{controllerAddress}}, {{controllerEmail}}.

Datenschutzbeauftragte Stelle: {{dpoName}}, {{dpoAddress}}, {{dpoEmail}}.

Wir haben Ihre Kontaktdaten, Identitäts- und Beschäftigungsdaten von Ihrem bisherigen Arbeitgeber erhalten, um das Transferprojekt vorzubereiten und durchzuführen. Rechtsgrundlagen sind Art. 6 Abs. 1 Buchst. b, c und f DSGVO sowie die einschlägigen Vorschriften des SGB III. Soweit besondere Kategorien personenbezogener Daten verarbeitet werden, gelten Art. 9 Abs. 2 Buchst. a oder b DSGVO.

Wir verarbeiten nur Daten, die für Beratung, Transfermaßnahmen, Vertragsvorbereitung, Beschäftigung in der Transfergesellschaft, Abrechnung und gesetzliche Meldungen erforderlich sind. Empfänger sind nur berechtigte Beschäftigte, zuständige öffentliche Stellen und vertraglich gebundene Auftragsverarbeiter. Eine Übermittlung an ein Drittland ist nicht vorgesehen.

Die Aufbewahrung richtet sich nach dem jeweiligen Zweck und den gesetzlichen Pflichten. Sie haben insbesondere Rechte auf Auskunft, Berichtigung, Löschung oder Einschränkung, Datenübertragbarkeit und Widerspruch sowie ein Beschwerderecht bei einer Datenschutzaufsichtsbehörde. Eine automatisierte Entscheidung einschließlich Profiling im Sinne von Art. 22 DSGVO findet nicht statt.`,
    sha256: "5b04bf44d103c6b05c1a2b8bbddeb3ed9558b84a7cc83a5082fd7e9ebde6902f",
  },
  en: {
    version: ART14_NOTICE_VERSION,
    language: "en",
    title: "Privacy information under Article 14 GDPR",
    text: `Controller: {{controllerName}}, {{controllerAddress}}, {{controllerEmail}}.

Data protection contact: {{dpoName}}, {{dpoAddress}}, {{dpoEmail}}.

We received your contact, identity and employment data from your former employer in order to prepare and operate the transfer project. The legal bases are Article 6(1)(b), (c) and (f) GDPR and the applicable provisions of Social Code Book III. Where special categories of personal data are processed, Article 9(2)(a) or (b) GDPR applies.

We process only data needed for counselling, transfer measures, contract preparation, employment by the transfer company, accounting and statutory reports. Recipients are limited to authorised staff, competent public bodies and contractually bound processors. No transfer to a third country is intended.

Retention depends on the purpose and applicable statutory duties. In particular, you have rights of access, rectification, erasure or restriction, data portability and objection, and the right to lodge a complaint with a data protection authority. No automated decision-making, including profiling within the meaning of Article 22 GDPR, takes place.`,
    sha256: "0f5daee7e0a2152d68f8e4a48bd7f0f185b98ee080c1e12d2d1c1f874b644e32",
  },
};

/**
 * Consent to the portal contact purpose for one private email or mobile (D28): login codes and
 * versioned portal notifications. Final wording: DPO review before real data, like the notice.
 */
const consentTemplates: Record<NoticeLanguage, NoticeTemplate> = {
  de: {
    version: PORTAL_CONTACT_CONSENT_VERSION,
    language: "de",
    title: "Einwilligung in den Kontakt über das Teilnehmerportal",
    text: `Ich willige ein, dass {{controllerName}} die von mir angegebene private E-Mail-Adresse oder Mobilnummer speichert und nutzt, um mir Anmeldecodes für das Teilnehmerportal und Benachrichtigungen aus dem Portal zu senden.

Die Angabe ist freiwillig. Ich kann diese Einwilligung jederzeit mit Wirkung für die Zukunft widerrufen, indem ich den Kontaktweg im Portal entferne oder mich an {{controllerEmail}} wende. Die Rechtmäßigkeit der bis zum Widerruf erfolgten Verarbeitung bleibt unberührt.`,
    sha256: "356247698c46c89c9dc2a718baaa764d567b5245eb720e0a3c511be9849a9724",
  },
  en: {
    version: PORTAL_CONTACT_CONSENT_VERSION,
    language: "en",
    title: "Consent to contact through the participant portal",
    text: `I consent to {{controllerName}} storing and using the private email address or mobile number I provide to send me login codes for the participant portal and notifications from the portal.

Providing it is voluntary. I can withdraw this consent at any time with effect for the future by removing the contact in the portal or by writing to {{controllerEmail}}. Withdrawal does not affect the lawfulness of processing before it.`,
    sha256: "c25c5b790d010b933061647ca1f1458f17ccdb0630e775dac6710942f5173a1f",
  },
};

export const noticeCatalog: readonly NoticeTemplate[] = [
  ...NoticeLanguage.options.map((language) => templates[language]),
  ...NoticeLanguage.options.map((language) => consentTemplates[language]),
];

const render = (template: NoticeTemplate, organisation: NoticeOrganisation) => {
  const replace = (text: string) =>
    Object.entries(organisation).reduce(
      (rendered, [key, value]) => rendered.replaceAll(`{{${key}}}`, value),
      text,
    );
  return { ...template, title: replace(template.title), text: replace(template.text) };
};

export function art14Notice(language: NoticeLanguage, organisation: NoticeOrganisation) {
  return render(templates[language], organisation);
}

export function portalContactConsent(language: NoticeLanguage, organisation: NoticeOrganisation) {
  return render(consentTemplates[language], organisation);
}
