import { z } from "zod";
import type { ReminderKind } from "../reminders/model";

export const NoticeLanguage = z.enum(["de", "en"]);
export type NoticeLanguage = z.infer<typeof NoticeLanguage>;

export const ART14_NOTICE_VERSION = "art14-activation:v1" as const;
/**
 * The first consent text of a portal contact channel (ADR-0007, Q119, Q125): still the evidence of
 * the channels that gave it; no new channel records it (data-protection.md, consent v2).
 */
export const PORTAL_CONTACT_CONSENT_V1 = "portal-contact-consent:v1" as const;
/**
 * The consent every new channel records (data-protection.md, consent v2; Q154): login codes and
 * operational notifications such as reminders, never advertising.
 */
export const PORTAL_CONTACT_CONSENT_VERSION = "portal-contact-consent:v2" as const;
/** The only consent version under which a channel receives a reminder (Q154). */
export const reminderConsentVersion = PORTAL_CONTACT_CONSENT_VERSION;
/** The reminder's fixed text (data-protection.md, reminders; Q154). */
export const PORTAL_REMINDER_VERSION = "portal-reminder:v1" as const;
/** The invitation's fixed text (data-protection.md, messages: the texts; Q165). */
export const PORTAL_INVITATION_VERSION = "portal-invitation:v1" as const;
/** The organizer's notice, for a changed and a cancelled appointment alike (Q165). */
export const PORTAL_APPOINTMENT_CHANGE_VERSION = "portal-appointment-change:v1" as const;
export type MessageVersion =
  | typeof PORTAL_REMINDER_VERSION
  | typeof PORTAL_INVITATION_VERSION
  | typeof PORTAL_APPOINTMENT_CHANGE_VERSION;
/**
 * The purposes notice before the first wizard page (data-protection.md, self-service; Q138): an
 * acknowledgement, not a consent.
 */
export const SELF_SERVICE_NOTICE_VERSION = "self-service-purposes:v1" as const;
export type NoticeVersion =
  | typeof ART14_NOTICE_VERSION
  | typeof PORTAL_CONTACT_CONSENT_V1
  | typeof PORTAL_CONTACT_CONSENT_VERSION
  | typeof SELF_SERVICE_NOTICE_VERSION;

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
 * Consent to the portal contact purpose for one private email or mobile (Q123): login codes and
 * versioned portal notifications. Final wording: DPO review before real data, like the notice.
 */
const consentV1Templates: Record<NoticeLanguage, NoticeTemplate> = {
  de: {
    version: PORTAL_CONTACT_CONSENT_V1,
    language: "de",
    title: "Einwilligung in den Kontakt über das Teilnehmerportal",
    text: `Ich willige ein, dass {{controllerName}} die von mir angegebene private E-Mail-Adresse oder Mobilnummer speichert und nutzt, um mir Anmeldecodes für das Teilnehmerportal und Benachrichtigungen aus dem Portal zu senden.

Die Angabe ist freiwillig. Ich kann diese Einwilligung jederzeit mit Wirkung für die Zukunft widerrufen, indem ich den Kontaktweg im Portal entferne oder mich an {{controllerEmail}} wende. Die Rechtmäßigkeit der bis zum Widerruf erfolgten Verarbeitung bleibt unberührt.`,
    sha256: "356247698c46c89c9dc2a718baaa764d567b5245eb720e0a3c511be9849a9724",
  },
  en: {
    version: PORTAL_CONTACT_CONSENT_V1,
    language: "en",
    title: "Consent to contact through the participant portal",
    text: `I consent to {{controllerName}} storing and using the private email address or mobile number I provide to send me login codes for the participant portal and notifications from the portal.

Providing it is voluntary. I can withdraw this consent at any time with effect for the future by removing the contact in the portal or by writing to {{controllerEmail}}. Withdrawal does not affect the lawfulness of processing before it.`,
    sha256: "c25c5b790d010b933061647ca1f1458f17ccdb0630e775dac6710942f5173a1f",
  },
};

/**
 * Consent v2 (data-protection.md, consent v2; Q154): login codes and operational notifications
 * from the portal, such as a reminder that something is open; never advertising; voluntary and
 * revocable. Final wording: DPO review before real data (Q132).
 */
const consentTemplates: Record<NoticeLanguage, NoticeTemplate> = {
  de: {
    version: PORTAL_CONTACT_CONSENT_VERSION,
    language: "de",
    title: "Einwilligung in den Kontakt über das Teilnehmerportal",
    text: `Ich willige ein, dass {{controllerName}} die von mir angegebene private E-Mail-Adresse oder Mobilnummer speichert und nutzt, um mir Anmeldecodes für das Teilnehmerportal und Benachrichtigungen zur Nutzung des Portals zu senden, zum Beispiel eine Erinnerung, dass dort noch etwas offen ist. Für Werbung wird der Kontaktweg nicht genutzt.

Die Angabe ist freiwillig. Ich kann diese Einwilligung jederzeit mit Wirkung für die Zukunft widerrufen, indem ich den Kontaktweg im Portal entferne oder mich an {{controllerEmail}} wende. Die Rechtmäßigkeit der bis zum Widerruf erfolgten Verarbeitung bleibt unberührt.`,
    sha256: "1551a38f2fd27b03d521a740430771a2eae339eb3fac0ee4b9409ddece294d7f",
  },
  en: {
    version: PORTAL_CONTACT_CONSENT_VERSION,
    language: "en",
    title: "Consent to contact through the participant portal",
    text: `I consent to {{controllerName}} storing and using the private email address or mobile number I provide to send me login codes for the participant portal and notifications about using the portal, for example a reminder that something is still open there. The contact is never used for advertising.

Providing it is voluntary. I can withdraw this consent at any time with effect for the future by removing the contact in the portal or by writing to {{controllerEmail}}. Withdrawal does not affect the lawfulness of processing before it.`,
    sha256: "ae97ab9ab27f1d4be9fd38dcadfc7cbcb5223c002e476527aeb2e4b653403308",
  },
};

/**
 * A message's fixed text (data-protection.md, reminders and messages; Q154, Q165): generic, its
 * only placeholder the plain portal URL; no name, project, employer, Personalnummer, deadline,
 * item, appointment kind, date, time, venue or title. The SHA-256 covers subject, text and the
 * email-only note joined by blank lines. Final wording with the DPO (Q132).
 */
export interface MessageTemplate<V extends MessageVersion = MessageVersion> {
  version: V;
  language: NoticeLanguage;
  subject: string;
  text: string;
  emailNote: string;
  sha256: string;
}
export type ReminderTemplate = MessageTemplate<typeof PORTAL_REMINDER_VERSION>;

const privacyNote: Readonly<Record<NoticeLanguage, string>> = {
  de: "Diese Nachricht enthält aus Datenschutzgründen keine weiteren Einzelheiten.",
  en: "For privacy reasons, this message contains no further details.",
};

export const reminderTemplates: Readonly<Record<NoticeLanguage, ReminderTemplate>> = {
  de: {
    version: PORTAL_REMINDER_VERSION,
    language: "de",
    subject: "Im Teilnehmerportal ist noch etwas offen",
    text: "In Ihrem Teilnehmerportal ist noch etwas offen. Bitte melden Sie sich an und prüfen Sie Ihre Angaben oder Unterlagen: {{portalUrl}}",
    emailNote: privacyNote.de,
    sha256: "6c179e836430938b1333586603061c8857d84a9d1aae5daad5d9a00e541cc61c",
  },
  en: {
    version: PORTAL_REMINDER_VERSION,
    language: "en",
    subject: "Something is still open in the participant portal",
    text: "Something is still open in your participant portal. Please sign in and review your information or documents: {{portalUrl}}",
    emailNote: privacyNote.en,
    sha256: "ee71cfb6dd4f9dbc5cce04d02401274a8bb0b37dc140ef1f095a2f62f01f658c",
  },
};

/** The invitation (Q165): one appointment waits in the portal, nothing said about which. */
export const invitationTemplates: Readonly<
  Record<NoticeLanguage, MessageTemplate<typeof PORTAL_INVITATION_VERSION>>
> = {
  de: {
    version: PORTAL_INVITATION_VERSION,
    language: "de",
    subject: "Neue Einladung im Teilnehmerportal",
    text: "In Ihrem Teilnehmerportal gibt es eine Einladung zu einem Termin. Bitte melden Sie sich an: {{portalUrl}}",
    emailNote: privacyNote.de,
    sha256: "eb943dadcf095d7dbae766af4a742c6c7f4bfc2e171870c346990c318bffa7e1",
  },
  en: {
    version: PORTAL_INVITATION_VERSION,
    language: "en",
    subject: "New invitation in the participant portal",
    text: "There is an invitation to an appointment in your participant portal. Please sign in: {{portalUrl}}",
    emailNote: privacyNote.en,
    sha256: "b70e188eab5b0b8421f8462236bc1a2c390a5e5f705ed09bc37551a7c75079ed",
  },
};

/** The organizer's notice (Q165), for a corrected title or venue and a cancellation alike. */
export const appointmentChangeTemplates: Readonly<
  Record<NoticeLanguage, MessageTemplate<typeof PORTAL_APPOINTMENT_CHANGE_VERSION>>
> = {
  de: {
    version: PORTAL_APPOINTMENT_CHANGE_VERSION,
    language: "de",
    subject: "Änderung im Teilnehmerportal",
    text: "Bei einem Ihrer Termine im Teilnehmerportal gibt es eine Änderung. Bitte melden Sie sich an: {{portalUrl}}",
    emailNote: privacyNote.de,
    sha256: "1a6efbe9df14fa995489503c1c3cf5825e7bd7643b8be7e55dd3f2c6ebdc9f71",
  },
  en: {
    version: PORTAL_APPOINTMENT_CHANGE_VERSION,
    language: "en",
    subject: "Change in the participant portal",
    text: "One of your appointments in the participant portal has changed. Please sign in: {{portalUrl}}",
    emailNote: privacyNote.en,
    sha256: "ca5e9a63d88a3e4230dfd5b1bfa84a9772391d6551be51f36806423e8878f3f8",
  },
};

/** Each message kind's fixed text; both notice kinds share one. */
export const messageTemplates: Readonly<
  Record<ReminderKind, Readonly<Record<NoticeLanguage, MessageTemplate>>>
> = {
  open_items: reminderTemplates,
  appointment_invitation: invitationTemplates,
  appointment_changed: appointmentChangeTemplates,
  appointment_cancelled: appointmentChangeTemplates,
};

/** The text version a message of `kind` is queued with (the database checks it again). */
export function messageVersionOf(kind: ReminderKind): MessageVersion {
  return messageTemplates[kind].de.version;
}

/**
 * A message as it is sent: by email the subject and the text with the privacy note, by SMS the
 * text alone; plain text with the portal URL as given (no token, id or tracking parameter).
 */
export function messageFor(
  kind: ReminderKind,
  language: NoticeLanguage,
  channel: "email" | "sms",
  portalUrl: string,
): { subject?: string; text: string } {
  const template = messageTemplates[kind][language];
  const text = template.text.replace("{{portalUrl}}", portalUrl);
  return channel === "email"
    ? { subject: template.subject, text: `${text}\n\n${template.emailNote}` }
    : { text };
}

/** The reminder as it is sent (`messageFor` of `open_items`). */
export function reminderMessage(
  language: NoticeLanguage,
  kind: "email" | "sms",
  portalUrl: string,
): { subject?: string; text: string } {
  return messageFor("open_items", language, kind, portalUrl);
}

/**
 * What the self-service data is for, per phase, and on which legal basis (data-protection.md,
 * legal basis; Q138). Shown before the first page; a new version is shown again before the next.
 * Final wording: DPO review before real data, like the notice.
 */
const purposesTemplates: Record<NoticeLanguage, NoticeTemplate> = {
  de: {
    version: SELF_SERVICE_NOTICE_VERSION,
    language: "de",
    title: "Wofür wir Ihre Angaben verwenden",
    text: `Mit Ihren Angaben bereiten {{controllerName}} und Ihre Beraterin oder Ihr Berater das Profiling und den Profilingbogen (TL 407) für die Agentur für Arbeit vor.

Vor dem Eintritt in die Transfergesellschaft dienen die Angaben der Beratung, dem Profiling und der Vorbereitung Ihres Vertrags (Art. 6 Abs. 1 Buchst. b DSGVO). Während der Beschäftigung in der Transfergesellschaft dienen sie der Vermittlung, der Qualifizierung und den gesetzlichen Meldungen an die Agentur für Arbeit (Art. 6 Abs. 1 Buchst. b und c DSGVO, §§ 110, 111 SGB III).

Gesundheitliche Einschränkungen und eine Schwerbehinderung oder Gleichstellung erfragen wir nur mit Ja oder Nein (Art. 9 Abs. 2 Buchst. b DSGVO). Bitte tragen Sie keine Diagnosen ein.

Angaben, die nicht als Pflicht markiert sind, können Sie auch im Gespräch mit Ihrer Beratung ergänzen. Ihre Rechte finden Sie in den Datenschutzhinweisen; Fragen richten Sie an {{controllerEmail}}.`,
    sha256: "120b74d84368c5a5fa9c1359dac9bbbfda0f13bd706b4a725eddfc664050d890",
  },
  en: {
    version: SELF_SERVICE_NOTICE_VERSION,
    language: "en",
    title: "What we use your details for",
    text: `With your details, {{controllerName}} and your counsellor prepare the profiling and the profiling form (TL 407) for the employment agency.

Before you join the transfer company, the details serve counselling, profiling and preparing your contract (Article 6(1)(b) GDPR). While you are employed by the transfer company, they serve placement, qualification and the statutory reports to the employment agency (Article 6(1)(b) and (c) GDPR, sections 110 and 111 of Social Code Book III).

We ask about health restrictions and a severe disability or equal status with yes or no only (Article 9(2)(b) GDPR). Please do not enter any diagnosis.

Details not marked as required can also be added with your counsellor. Your rights are set out in the privacy information; please send questions to {{controllerEmail}}.`,
    sha256: "ee22d8a09cb68241bc58e810fb8c661c66b8397a67215e0a7333a3e071d920f8",
  },
};

export const noticeCatalog: readonly NoticeTemplate[] = [
  ...NoticeLanguage.options.map((language) => templates[language]),
  ...NoticeLanguage.options.map((language) => consentV1Templates[language]),
  ...NoticeLanguage.options.map((language) => purposesTemplates[language]),
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

/** The consent a channel records now (v2); v1 stays in the catalog as evidence only. */
export function portalContactConsent(language: NoticeLanguage, organisation: NoticeOrganisation) {
  return render(consentTemplates[language], organisation);
}

export function selfServicePurposesNotice(
  language: NoticeLanguage,
  organisation: NoticeOrganisation,
) {
  return render(purposesTemplates[language], organisation);
}
