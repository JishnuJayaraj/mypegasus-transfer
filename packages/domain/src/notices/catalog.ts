import { z } from "zod";

export const NoticeLanguage = z.enum(["de", "en"]);
export type NoticeLanguage = z.infer<typeof NoticeLanguage>;

export const ART14_NOTICE_VERSION = "art14-activation:v1" as const;

export interface NoticeOrganisation {
  controllerName: string;
  controllerAddress: string;
  controllerEmail: string;
  dpoName: string;
  dpoAddress: string;
  dpoEmail: string;
}

export interface NoticeTemplate {
  version: typeof ART14_NOTICE_VERSION;
  language: NoticeLanguage;
  title: string;
  text: string;
  sha256: string;
}

const templates: Record<NoticeLanguage, Omit<NoticeTemplate, "sha256"> & { sha256: string }> = {
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

export const noticeCatalog: readonly NoticeTemplate[] = NoticeLanguage.options.map(
  (language) => templates[language],
);

export function art14Notice(language: NoticeLanguage, organisation: NoticeOrganisation) {
  const template = templates[language];
  const replace = (text: string) =>
    Object.entries(organisation).reduce(
      (rendered, [key, value]) => rendered.replaceAll(`{{${key}}}`, value),
      text,
    );
  return { ...template, title: replace(template.title), text: replace(template.text) };
}
