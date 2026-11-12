import {
  fieldCatalog,
  type DataClass,
  type FieldEntry,
  type RetentionPeriods,
  type RetentionPrerequisites,
} from "@transfer/domain";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { tables } from "./schema";

export interface CatalogEntry {
  /** Retention is per data item, never per person (ADR-0008). */
  retentionClass: string;
  dataClass: DataClass;
  /** Participant data must be scoped by a `project_id` FK (ADR-0002). */
  holdsParticipantData: boolean;
}

/**
 * Retention periods of the classes (ADR-0008; the rules: `retentionRules` in the domain). `unset`
 * means no deletion may touch the class: the retention job reports it `period_unset`. The job
 * reads the periods from here only, never from the environment.
 */
export const retentionPeriods = {
  project_master: "unset", // Q58
  staff_account: "unset", // Q59 (assumed: deactivate and pseudonymise, never delete)
  // ADR-0008 per item; non-signers from `withdrawn_on` (90 days assumed, Q77), the rest with
  // the personnel file and the evidence set (Slice 7).
  participation_record: "unset",
  // Q105 (accepted pilot decision, round 32): non-signers 90 days after `withdrawnOn`; otherwise
  // the end of the 3rd calendar year after exit, cancellation or contractual end; never in the BA
  // evidence set. The Slice 7 retention job will encode the period.
  personnel_file: "unset",
  // Q141: the structured health and disability yes/no answers, 3 months after exit or with the
  // non-signer deletion (data-protection.md, retention); stored with the encrypted fields.
  health_record: "unset",
  // 3 years; pseudonymised when the subject's data is deleted; evidence-set entries follow the
  // evidence set (verify, Q3).
  audit_log: "unset",
  // Q122 (assumed): sessions (and from 3d codes and one-time challenges) are deleted, or stripped of
  // their hashes and addresses, 30 days after use, expiry, lock, revocation or end; a legal hold
  // never keeps a secret usable.
  access_credential: "unset",
  // The BA evidence set (ADR-0008, stage two; Q3, Q64): signed TL 407 and Kug 200b scans; follows
  // the funding's retention, set by Slice 7.
  evidence_set: "unset",
  // Q179 (accepted, periods awaiting the DPO): a generated form's file 30 days after a newer
  // generation or its accepted signed scan, 90 days after an abandoned generation, 30 days after the
  // participation's terminal status (`workingCopyExpiry`), a legal hold suspending each; the row
  // and its provenance stay as the tombstone.
  form_working_copy: "unset",
  // Stored objects without a document row: a day after they were written (data-protection.md,
  // retention as built); unset with the others until confirmed.
  orphaned_object: "unset",
  // No personal data: the retention job never touches it.
  reference_data: "never",
} as const satisfies RetentionPeriods;

/**
 * The prerequisites of any live deletion (data-protection.md, retention; Q219): until each is
 * met the retention job is a dry run that computes and counts, and deletes nothing. Confirmed
 * periods (Q3, Q24), confirmed hold administration (Q218, including individual document and identity holds),
 * evidence-only access (break-glass,
 * not built) and the maintenance rules (backups at most 30 days, an erasure's restore behaviour).
 */
export const retentionPrerequisites: RetentionPrerequisites = {
  periods_confirmed: false,
  hold_administration_confirmed: false,
  evidence_only_access_built: false,
  maintenance_rules_complete: false,
};

/**
 * Inventory of participation-reference tables (data-protection.md, retention and deletion), **in
 * the erasure order**: `retention_erase_participation` deletes in this order, so a table stands
 * before every table it references, except across a deferred edge
 * (`erasureDeferredForeignKeys`). A new table is placed here by hand. `audit_event` is never
 * deleted: the erasure pseudonymises it last. The function's list is generated from this one
 * (ADR-0002, generated lists).
 */
export const erasureParticipationTables = [
  "asu_registration",
  "ba_reporting_task",
  "document_link",
  "dsv_contract",
  "dsv_scan_signature",
  "entry_clarification_step",
  "kug200b_batch_member",
  "kug200b_withdrawal",
  "participant_account",
  "participant_reminder",
  "participant_session",
  "privacy_notice_delivery",
  "profiling_exception_request",
  "signed_declaration",
  "tg_entry_reconciliation_step",
  "activation_code",
  "agentur_submission",
  "appointment_booking",
  "entry_clarification",
  "evidence_correction",
  "participant_channel",
  "participation_dsv_amendment",
  "profiling_exception_evidence_record",
  "tg_entry_reconciliation",
  "consent_record",
  "document",
  "dsv_offer",
  "form_generation",
  "assisted_mode",
  "asu_record",
  "dsv_customer_notice",
  "kug200b_decline",
  "legal_hold",
  "one_time_code_challenge",
  "participant_assignment",
  "participant_details",
  "participant_health_data",
  "participant_identifier_data",
  "participant_identity",
  "participant_profile",
  "participant_profiling",
  "participant_profiling_assessment",
  "participant_profiling_health_assessment",
  "participant_residence_social_data",
  "profiling_session",
  "self_service_notice_acknowledgement",
  "audit_event",
] as const;

/**
 * Tables naming a participation that stay writable in the evidence-only phase and while an
 * erasure is pending (data-protection.md, retention and deletion): the audit trail, append-only
 * by its own trigger, and the holds themselves. Every other table of the inventory, and
 * `participation`, carries the evidence-only trigger, generated from here (ADR-0002, generated
 * lists).
 */
export const evidenceOnlyExemptTables: readonly string[] = ["audit_event", "legal_hold"];

/** The tables carrying the evidence-only trigger `refuse_in_evidence_set_phase`. */
export const evidenceOnlyTables = (
  participationTables: readonly string[] = erasureParticipationTables,
): string[] =>
  ["participation", ...participationTables]
    .filter((name) => !evidenceOnlyExemptTables.includes(name))
    .toSorted();

/** The tables `retention_erase_participation` deletes from, in its order. */
export const erasureDeletionTables = (
  participationTables: readonly string[] = erasureParticipationTables,
): string[] => participationTables.filter((name) => name !== "audit_event");

/** Foreign-key cycle edges that the erasure transaction must defer. */
export const erasureDeferredForeignKeys: readonly string[] = [
  "form_generation_document_id_document_id_fk",
  "document_invalidated_by_correction_evidence_correction_id_fk",
  "evidence_correction_asu_registration_id_asu_registration_id_fk",
  "evidence_correction_ba_reporting_task_id_ba_reporting_task_id_f",
  "participation_current_exception_request_fk",
];

/** FK parents that can be retained by a hold during erasure (data-protection.md, retained dependencies). */
export const erasureRetainedDependencies = [
  { table: "audit_event", referencedBy: ["dsv_offer"], retentionClass: "audit_log" },
  {
    table: "activation_code",
    referencedBy: ["participant_account", "privacy_notice_delivery"],
    retentionClass: "access_credential",
  },
  {
    table: "agentur_submission",
    referencedBy: ["asu_registration", "agentur_submission"],
    retentionClass: "participation_record",
  },
  {
    table: "appointment_booking",
    referencedBy: ["participant_reminder", "appointment_booking"],
    retentionClass: "personnel_file",
  },
  {
    table: "asu_registration",
    referencedBy: ["evidence_correction"],
    retentionClass: "participation_record",
  },
  {
    table: "ba_reporting_task",
    referencedBy: ["evidence_correction", "ba_reporting_task"],
    retentionClass: "participation_record",
  },
  {
    table: "consent_record",
    referencedBy: ["participant_channel", "participant_reminder"],
    retentionClass: "personnel_file",
  },
  {
    table: "document",
    referencedBy: [
      "asu_registration",
      "agentur_submission",
      "consent_record",
      "dsv_scan_signature",
      "evidence_correction",
      "form_generation",
      "legal_hold",
    ],
    retentionClass: "by_document_type",
  },
  {
    table: "dsv_offer",
    referencedBy: ["document", "dsv_contract", "evidence_correction"],
    retentionClass: "participation_record",
  },
  {
    table: "evidence_correction",
    referencedBy: ["document", "dsv_scan_signature", "asu_registration", "ba_reporting_task"],
    retentionClass: "by_document_type",
  },
  {
    table: "form_generation",
    referencedBy: ["document", "dsv_offer"],
    retentionClass: "form_working_copy",
  },
  {
    table: "participant_channel",
    referencedBy: ["participant_reminder", "consent_record"],
    retentionClass: "personnel_file",
  },
  {
    table: "participation_dsv_amendment",
    referencedBy: ["ba_reporting_task"],
    retentionClass: "participation_record",
  },
].map((dependency) => ({ ...dependency, until: "all retained referencing rows are removed" }));

/** Rows waiting for a referencing row (data-protection.md, retained dependencies). */
export const retainedDependencies = [
  {
    table: "activation_code",
    referencedBy: "participant_session",
    retentionClass: "access_credential",
    until: "session deleted",
  },
  {
    table: "staff_session",
    referencedBy: "assisted_mode",
    retentionClass: "access_credential",
    until: "assisted mode deleted",
  },
  {
    table: "appointment_booking",
    referencedBy: "participant_reminder",
    retentionClass: "personnel_file",
    until: "reminder deleted",
  },
  {
    table: "participant_channel",
    referencedBy: "participant_reminder",
    retentionClass: "personnel_file",
    until: "reminder deleted",
  },
  {
    table: "consent_record",
    referencedBy: "participant_reminder",
    retentionClass: "personnel_file",
    until: "reminder deleted",
  },
  {
    table: "consent_record",
    referencedBy: "participant_channel",
    retentionClass: "personnel_file",
    until: "channel deleted",
  },
  {
    table: "consent_record",
    referencedBy: "kug200b_withdrawal",
    retentionClass: "personnel_file",
    until: "withdrawal deleted",
  },
  {
    table: "dsv_scan_signature",
    referencedBy: "document",
    retentionClass: "personnel_file",
    until: "document hold released",
  },
] as const;

/**
 * The class of a table whose rows carry their own (ADR-0008, per item), in its `retention_class`
 * column: `document`, each row its type's class from the document type catalog;
 * `evidence_correction`, each row its target's class.
 */
export const perRowRetention = "by_document_type";

export const dataCatalog: Record<string, CatalogEntry> = {
  project: { retentionClass: "project_master", dataClass: "internal", holdsParticipantData: false },
  staff_user: {
    retentionClass: "staff_account",
    dataClass: "confidential",
    holdsParticipantData: false,
  },
  // Staff sessions (ADR-0007, staff sessions): a token's SHA-256, the staff user, the times; never
  // the token.
  staff_session: {
    retentionClass: "access_credential",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  // Staff authentication and administration history (data-protection.md): staff ids, counts and
  // codes only, including removed roles and their region; never names or emails.
  staff_audit_event: {
    retentionClass: "audit_log",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  // Regions (Niederlassungen, Q35, Q126): codes and names, no personal data.
  region: { retentionClass: "reference_data", dataClass: "internal", holdsParticipantData: false },
  // Current org roles (data-protection.md): staff ids, role, region and who granted it when.
  // Revocation or deactivation deletes the grant; the staff audit trail preserves its history.
  staff_org_role: {
    retentionClass: "staff_account",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  // Participant assignments (Q62): which consultant a participation is assigned to, by whom and
  // when, and how it ended; ids and codes only, closed, never deleted.
  participant_assignment: {
    retentionClass: "participation_record",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // Who holds which project role (data-protection.md, access matrix); staff ids only, no
  // participant data.
  project_membership: {
    retentionClass: "project_master",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  project_entry_wave: {
    retentionClass: "project_master",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  participation: {
    retentionClass: "participation_record",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  // Person data (data-protection.md, retention; Q105): identity in the participation record, the
  // rest in the personnel file; one row each per participation.
  participant_identity: {
    retentionClass: "participation_record",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  participant_details: {
    retentionClass: "personnel_file",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  // The participant's profile, TL 407 section B (Q140, Q141): the wizard's confidential answers.
  participant_profile: {
    retentionClass: "personnel_file",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  // The encrypted self-service fields (ADR-0002, encryption; Q135, Q141): ciphertexts, their
  // presence, the key id and times; one row per participation, one retention class per table.
  participant_identifier_data: {
    retentionClass: "participation_record",
    dataClass: "highly_confidential",
    holdsParticipantData: true,
  },
  participant_residence_social_data: {
    retentionClass: "personnel_file",
    dataClass: "highly_confidential",
    holdsParticipantData: true,
  },
  participant_health_data: {
    retentionClass: "health_record",
    dataClass: "special_category",
    holdsParticipantData: true,
  },
  // The profiling record (data-protection.md, the profiling record; Q88, Q192, Q193): the pending
  // declarations to the BA and the record's revision; the sessions, evidence-set data; section C
  // and p. 7 encrypted, the health line's rating in its own table with the health answers' class.
  participant_profiling: {
    retentionClass: "personnel_file",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  profiling_session: {
    retentionClass: "participation_record",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  participant_profiling_assessment: {
    retentionClass: "personnel_file",
    dataClass: "highly_confidential",
    holdsParticipantData: true,
  },
  participant_profiling_health_assessment: {
    retentionClass: "health_record",
    dataClass: "special_category",
    holdsParticipantData: true,
  },
  // The purposes notice acknowledged (Q138): version, language, actor and time; immutable.
  self_service_notice_acknowledgement: {
    retentionClass: "personnel_file",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // Activation credentials keep only separately keyed hashes, never a code or destination.
  activation_code: {
    retentionClass: "access_credential",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  // Immutable Art. 14 delivery evidence: version, language, method, staff id and time.
  privacy_notice_delivery: {
    retentionClass: "personnel_file",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // Portal activation (ADR-0007; Q122, Q123). The account: activation time, code id,
  // how the identity was assured (staff confirmer for a photo ID) and the language.
  participant_account: {
    retentionClass: "personnel_file",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // Value-free consent proof: purpose, channel id, text version, language, who and when; it stays
  // with the personnel file after the address is erased (Q122).
  consent_record: {
    retentionClass: "personnel_file",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  // The verified private email or mobile (`portalChannels`); staff see kind, state and dates only.
  // The address is erased 30 days after removal (Q122).
  participant_channel: {
    retentionClass: "personnel_file",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  // One-time codes: a keyed hash and the address they went to, stripped with the credential.
  one_time_code_challenge: {
    retentionClass: "access_credential",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  // Participant sessions: a token's SHA-256, state, step-ups and times; never served to staff.
  participant_session: {
    retentionClass: "access_credential",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // Assisted mode (Q136): which staff session opened the wizard for a participation, how and
  // when; ids, a session hash, a code and times. It ends with the staff session.
  assisted_mode: {
    retentionClass: "access_credential",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // Documents (data-protection.md, uploads and documents; Q145): the metadata of an encrypted file
  // in the store (type, media type, size, the kept file name, who added and reviewed it, a deletion's
  // tombstone; a signed scan's origin, generation, version, signature dates and confirmations; a
  // quarantine), its wrapped key and content hash, which the runtime role can't select; each row of
  // its type's class.
  document: {
    retentionClass: perRowRetention,
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  // A generated form's provenance (data-protection.md, generated forms; Q179): the document, form
  // code and version, the source revisions, the declarations it printed, the confirmed warning
  // codes, the Anlage, who generated it and when. Its row stays when the working copy's file goes.
  dsv_scan_signature: {
    retentionClass: "personnel_file",
    dataClass: "highly_confidential",
    holdsParticipantData: true,
  },
  // The signed offer's retained facts and its original's tracking (D24); the location goes with
  // the personnel file, the rest stays with the participation record.
  dsv_contract: {
    retentionClass: "participation_record",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // The entry clarification of a signed DSV that has not entered: the PL's pending code and
  // documented source, the escalation and the manager's instruction. The sources are one line each,
  // `case_internal`, never in the history or a log.
  entry_clarification: {
    retentionClass: "participation_record",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // Every step of an entry clarification (the PL's notes and replies, the manager's requests and
  // instructions), each with its one documented source line: `case_internal`.
  entry_clarification_step: {
    retentionClass: "participation_record",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // "Kunde informiert am" of a cancellation-based withdrawal: the day, by/at (Q46).
  dsv_customer_notice: {
    retentionClass: "participation_record",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // The reconciliation of a missed TG entry (Q68 case 2): the effective date, the evidence's kinds,
  // record ids and days, the PL's confirmation, the review's stage. `case_internal`.
  tg_entry_reconciliation: {
    retentionClass: "participation_record",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // Every step of its review (the manager's outcomes, the PL's replies) with its code and one
  // documented source line (Q209's rules, Q216): `case_internal`, never in a history or a log.
  tg_entry_reconciliation_step: {
    retentionClass: "participation_record",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  dsv_offer: {
    retentionClass: "participation_record",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  form_generation: {
    retentionClass: "form_working_copy",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  // The declarations of an accepted signed form (data-protection.md, signed declarations; Q193):
  // the scan, the form's code and version, each declaration as marked, the signature date, who
  // recorded it and when; immutable, part of the signed form's evidence.
  signed_declaration: {
    retentionClass: "participation_record",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  // The ASU record (process-and-lifecycle.md, Arbeitsuchendmeldung; Q186): the route and the
  // registration with its proof, codes, dates and staff ids; part of the evidence of entry (Q88).
  asu_record: {
    retentionClass: "participation_record",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  asu_registration: {
    retentionClass: "participation_record",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // The Kug 200b offer (process-and-lifecycle.md, the Kug 200b offer; Q185): a decline's date and
  // a withdrawal's receipt and BA notice, the consent record it ended, staff ids and times.
  kug200b_decline: {
    retentionClass: "participation_record",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  kug200b_withdrawal: {
    retentionClass: "participation_record",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // Kug 200b batches (process-and-lifecycle.md, Kug 200b batches): the batch is project data
  // (Agentur, channel, artifact, status, dates, staff ids); its members and the submissions are the
  // participation's proof of submission (Q88).
  kug200b_batch: {
    retentionClass: "project_master",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  kug200b_batch_member: {
    retentionClass: "participation_record",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  agentur_submission: {
    retentionClass: "participation_record",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // Export links (data-protection.md, exports): a token's SHA-256, the project, the kind, the
  // document ids or the batch, the staff user and session hash, expiry; no file.
  // A retention job's run: the day, dry or not, and counts per class; no subject.
  retention_run: {
    retentionClass: "reference_data",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  // A legal hold (Q218): the held classes, record kinds or document ids of one participation, the
  // reason code and the documented basis, who placed and released it with the instruction's
  // source. Kept while active, then as the audit log (data-protection.md, legal holds).
  legal_hold: {
    retentionClass: "audit_log",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  export_link: {
    retentionClass: "access_credential",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // Opening links (Q147): a token's SHA-256, the document, the session's kind and hash, expiry.
  document_link: {
    retentionClass: "access_credential",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // Messages (data-protection.md, reminders and messages; Q156, Q165): reminders, invitations and
  // organizer notices; ids, codes, versions, times and a notice's follow-up; never an address, a
  // text or a provider response. The `personnel_file` triggers of Q105 and Q166 (mapping awaiting
  // confirmation, period `unset`); the channel keeps its own erasure rule.
  participant_reminder: {
    retentionClass: "personnel_file",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // Appointments (data-protection.md, appointments; Q58, Q166): project data, kind, times,
  // capacity, the generic title and the shared venue; the host and creator are staff ids (Q59).
  appointment: {
    retentionClass: "project_master",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  // Bookings (Q163, Q166, Q167): which appointment, origin, status, attendance, the basis of
  // `informed` and its conflict, a follow-up link and a missed appointment's resolution, closed
  // reasons, staff ids and times; the `personnel_file` triggers of Q105
  // and Q166 (mapping awaiting confirmation, period `unset`).
  appointment_booking: {
    retentionClass: "personnel_file",
    dataClass: "internal",
    holdsParticipantData: true,
  },
  // The document type catalog per version (classes, file names, roles): no personal data.
  document_type_policy: {
    retentionClass: "reference_data",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  // The audit history's projection, role knowledge and field categories (Q157): no personal data.
  audit_event_projection: {
    retentionClass: "reference_data",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  role_field_knowledge: {
    retentionClass: "reference_data",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  field_access_category: {
    retentionClass: "reference_data",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  // Reason codes are confidential (Q66); evidence records get their own class (round 16).
  profiling_exception_request: {
    retentionClass: "participation_record",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  // The evidence a request rests on (data-protection.md, exception evidence; Q81, Q194): document
  // ids or the normalised BA confirmation; the documents themselves are catalogued by their type.
  profiling_exception_evidence_record: {
    retentionClass: "participation_record",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  audit_event: {
    retentionClass: "audit_log",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  lifecycle_edge: {
    retentionClass: "reference_data",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  // Job names, run dates and instants only (ADR-0011).
  job_run: { retentionClass: "reference_data", dataClass: "internal", holdsParticipantData: false },
  // File names and content hashes of the function sources (ADR-0002, function sources).
  function_source: {
    retentionClass: "reference_data",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  // Template versions as released (regional-variation.md, "Template versions"): no personal data,
  // global, never deleted.
  config_template_version: {
    retentionClass: "reference_data",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  // Which versions a project pinned, by whom and when (staff ids only).
  project_template_pin: {
    retentionClass: "project_master",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  // Override versions: Agentur-scoped settings (channels, source codes, confirming staff id and
  // date) and relaxations; project-wide, no participant data.
  project_config_override: {
    retentionClass: "project_master",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  // Relaxation requests: rule id, reason code, status, staff ids and dates; project-wide, no
  // participant data (data-protection.md, retention).
  config_relaxation_request: {
    retentionClass: "project_master",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  // Saved import column mappings: the keyed hash of a normalised header and its target, never
  // header text; the application writes them without an audit (data-protection.md, retention).
  // Confidential, possibly pseudonymised participant data (round 33): a data row picked as the
  // header would make the hashes keyed hashes of a person's values, which the confirm avoids for a
  // header row that looks like data. No link to a person or participation, so it stays with the
  // project.
  import_column_mapping: {
    retentionClass: "project_master",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  // DSV amendments and BA reporting tasks (process-and-lifecycle.md, "DSV amendment", "BA
  // reporting"; round 32): evidence of
  // contractual date changes, in the participation record and its evidence set.
  participation_dsv_amendment: {
    retentionClass: "participation_record",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  ba_reporting_task: {
    retentionClass: "participation_record",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  // Evidence corrections (data-protection.md, evidence corrections; Q209): the target's class per
  // row (a document's type's, else `participation_record`), codes, dates and the source reference.
  evidence_correction: {
    retentionClass: perRowRetention,
    dataClass: "internal",
    holdsParticipantData: true,
  },
};

/** Returns one message per problem; empty when every table is catalogued and scoped. */
export function checkDataCatalog(
  schemaTables: PgTable[] = tables,
  catalog: Record<string, CatalogEntry> = dataCatalog,
): string[] {
  const configs = schemaTables.map((table) => getTableConfig(table));
  const names = new Set(configs.map((config) => config.name));
  const problems: string[] = [];

  for (const config of configs) {
    const entry = catalog[config.name];
    if (!entry) {
      problems.push(`${config.name}: missing from the data catalog`);
    } else if (entry.retentionClass === perRowRetention) {
      if (!config.columns.some((column) => column.name === "retention_class")) {
        problems.push(`${config.name}: a class per row needs a retention_class column`);
      }
      if (entry.holdsParticipantData && !isProjectScoped(config)) {
        problems.push(
          `${config.name}: holds participant data but has no project_id uuid not null FK to project`,
        );
      }
    } else if (!Object.hasOwn(retentionPeriods, entry.retentionClass)) {
      problems.push(`${config.name}: unknown retention class ${entry.retentionClass}`);
    } else if (entry.holdsParticipantData && !isProjectScoped(config)) {
      problems.push(
        `${config.name}: holds participant data but has no project_id uuid not null FK to project`,
      );
    }
  }
  for (const name of Object.keys(catalog)) {
    if (!names.has(name)) problems.push(`${name}: in the data catalog but not in the schema`);
  }
  return problems;
}

const encryptedKeys = {
  participation_id: null,
  project_id: null,
  key_id: null,
  created_at: null,
  written_at: null,
};

/**
 * The field-catalog key of each column of the tables holding participant fields
 * (data-protection.md, Classification): null for a column that isn't a participant field (keys,
 * references, versions, workflow metadata). The address parts and the country are the field
 * `address` (round 32). Every column of these tables is classified here, so a new column needs a
 * decision.
 */
export const fieldColumns: Record<string, Record<string, string | null>> = {
  participation: {
    id: null,
    project_id: null,
    entry_wave_id: null,
    status: "status",
    profiling_status: "profilingStatus",
    dsv_status: "dsvStatus",
    offer_deadline: "offerDeadline",
    tg_start: "tgStart",
    tg_end: "tgEnd",
    tg_entry_date: "tgEntryDate",
    exit_date: "exitDate",
    withdrawn_on: "withdrawnOn",
    profiling_done_on: "profilingDoneOn",
    // The health-related value can't be stored (a CHECK, Q66), so the column stays confidential.
    end_reason: "endReason",
    end_reason_source: null,
    end_reason_secondary: "endReason",
    profiling_exception_request_id: null,
    status_version: null,
    placement_agentur_key: "placementAgenturKey",
    placement_agentur_set_at: "placementAgenturKey",
    funded110: "funded110",
    funded110_source: "funded110",
    funded110_set_by: null,
    funded110_set_at: "funded110",
    evidence_set_since: null,
    erasure_pending_at: null,
    erasure_entered_tg: null,
    erasure_trigger: null,
    erasure_trigger_on: null,
    created_at: null,
  },
  profiling_exception_evidence_record: {
    id: null,
    project_id: null,
    participation_id: null,
    kind: "profilingExceptionEvidence",
    document_ids: null,
    agentur_key: "profilingExceptionEvidence",
    reference: "profilingExceptionEvidence",
    confirmed_on: "profilingExceptionEvidence",
    fingerprint: null,
    created_by: null,
    created_on: null,
    created_at: null,
  },
  profiling_exception_request: {
    id: null,
    project_id: null,
    participation_id: null,
    reason_code: "profilingExceptionReasonCode",
    status: null,
    requested_by: null,
    requested_on: null,
    requested_at: null,
    evidence_record_id: null,
    evidence_fingerprint: null,
    decided_by: null,
    decided_on: null,
    decided_at: null,
    superseded_reason: null,
  },
  participant_identity: {
    participation_id: null,
    project_id: null,
    personnel_number: "personnelNumber",
    last_name: "lastName",
    first_name: "firstName",
    birth_date: "birthDate",
    created_at: null,
    updated_at: null,
  },
  participant_details: {
    participation_id: null,
    project_id: null,
    address_street: "address",
    address_postal_code: "address",
    address_city: "address",
    address_country: "address",
    phone: "phone",
    mobile: "mobile",
    private_email: "privateEmail",
    work_email: "workEmail",
    old_employment_end_date: "oldEmploymentEndDate",
    knowledge_date: "knowledgeDate",
    // Which contact fields the participant wrote, and when the address (Q112, Q139): metadata
    participant_maintained: null,
    participant_address_written_at: null,
    created_at: null,
    updated_at: null,
  },
  participant_profile: {
    participation_id: null,
    project_id: null,
    gender: "gender",
    marital_status: "maritalStatus",
    education_history: "educationHistory",
    work_history: "workHistory",
    language_skills: "languageSkills",
    driving_licence: "drivingLicence",
    vehicle_available: "vehicleAvailable",
    working_time_preferences: "workingTimePreferences",
    job_wishes: "jobWishes",
    desired_work_locations: "desiredWorkLocations",
    max_commute_distance: "maxCommuteDistance",
    earliest_start_date: "earliestStartDate",
    // Custom fields are confidential at most and carry their own retention class in the
    // template's field schema (regional-variation.md, custom fields).
    custom_fields: null,
    revision: null,
    created_at: null,
    updated_at: null,
  },
  // A ciphertext column stores its field; the presence beside it is metadata (completeness needs
  // only that, data-protection.md, self-service), like the key id.
  participant_identifier_data: {
    ...encryptedKeys,
    pension_insurance_number: "pensionInsuranceNumber",
    pension_insurance_number_present: null,
    ba_customer_number: "baCustomerNumber",
    ba_customer_number_present: null,
  },
  asu_record: {
    participation_id: null,
    project_id: null,
    channel: "asuChannel",
    version: null,
    set_by: null,
    set_at: "asuChannel",
  },
  asu_registration: {
    id: null,
    project_id: null,
    participation_id: null,
    channel: "asuRegistration",
    registered_on: "asuRegistration",
    recorded_by: null,
    recorded_at: "asuRegistration",
    proof_kind: "asuRegistration",
    proof_document_id: null,
    attestation_source: "asuRegistration",
    proof_linked_by: null,
    proof_linked_at: "asuRegistration",
    agentur_submission_id: null,
    confirmed_on: "asuRegistration",
    confirmed_by: null,
    confirmed_at: "asuRegistration",
    superseded_by: null,
    invalidated_by: null,
    correction_id: null,
  },
  kug200b_batch_member: {
    batch_id: "agenturSubmissions",
    project_id: null,
    participation_id: null,
    document_id: null,
    form_version: "agenturSubmissions",
    asu_channel: "agenturSubmissions",
    placement_agentur_key: "agenturSubmissions",
    active: "agenturSubmissions",
  },
  agentur_submission: {
    id: null,
    project_id: null,
    participation_id: null,
    document_id: null,
    form_code: "agenturSubmissions",
    form_version: "agenturSubmissions",
    agentur_key: "agenturSubmissions",
    channel: "agenturSubmissions",
    batch_id: "agenturSubmissions",
    submitted_on: "agenturSubmissions",
    recorded_by: null,
    recorded_at: "agenturSubmissions",
    original_required: "agenturSubmissions",
    original_sent_on: "agenturSubmissions",
    original_recorded_by: null,
    original_recorded_at: "agenturSubmissions",
    original_retained_from: "agenturSubmissions",
    rejected_on: "agenturSubmissions",
    rejection_reason: "agenturSubmissions",
    rejection_recorded_by: null,
    rejection_recorded_at: "agenturSubmissions",
  },
  kug200b_decline: {
    participation_id: null,
    project_id: null,
    declined_on: "kug200bOffer",
    declined_by: null,
    declined_at: "kug200bOffer",
  },
  kug200b_withdrawal: {
    id: null,
    project_id: null,
    participation_id: null,
    consent_id: null,
    received_on: "kug200bOffer",
    recorded_by: null,
    recorded_at: "kug200bOffer",
    ba_notified_on: "kug200bOffer",
    ba_notified_by: null,
    ba_notified_at: "kug200bOffer",
  },
  participant_residence_social_data: {
    ...encryptedKeys,
    nationality: "nationality",
    nationality_present: null,
    entry_to_germany_date: "entryToGermanyDate",
    entry_to_germany_date_present: null,
    residence_status: "residenceStatus",
    residence_status_present: null,
    buergergeld: "buergergeld",
    buergergeld_present: null,
    unemployment_period: "unemploymentPeriod",
    unemployment_period_present: null,
    unemployment_revision: null,
  },
  participant_health_data: {
    ...encryptedKeys,
    health_restrictions: "healthRestrictions",
    health_restrictions_present: null,
    severe_disability: "severeDisability",
    severe_disability_present: null,
  },
  participant_profiling: {
    participation_id: null,
    project_id: null,
    jobboerse_choice: "jobboerseChoice",
    ba_contact_consent: "baContactConsent",
    declarations_recorded_by: null,
    declarations_recorded_at: null,
    revision: null,
    created_at: null,
    updated_at: null,
  },
  profiling_session: {
    id: null,
    project_id: null,
    participation_id: null,
    session_date: "profilingSessions",
    time_from: "profilingSessions",
    time_to: "profilingSessions",
    recorded_by: null,
    recorded_at: null,
  },
  participant_profiling_assessment: {
    ...encryptedKeys,
    school_qualification: "profilingAssessment",
    school_qualification_present: null,
    vocational_qualification: "profilingAssessment",
    vocational_qualification_present: null,
    work_experience: "profilingAssessment",
    work_experience_present: null,
    language_skills: "profilingAssessment",
    language_skills_present: null,
    other_qualification: "profilingAssessment",
    other_qualification_present: null,
    intellectual_capacity: "profilingAssessment",
    intellectual_capacity_present: null,
    work_and_social_behaviour: "profilingAssessment",
    work_and_social_behaviour_present: null,
    other_performance: "profilingAssessment",
    other_performance_present: null,
    initiative: "profilingAssessment",
    initiative_present: null,
    learning_readiness: "profilingAssessment",
    learning_readiness_present: null,
    other_motivation: "profilingAssessment",
    other_motivation_present: null,
    local_mobility: "profilingAssessment",
    local_mobility_present: null,
    other_conditions: "profilingAssessment",
    other_conditions_present: null,
    overall_assessment: "overallAssessment",
    overall_assessment_present: null,
    next_steps: "nextSteps",
    next_steps_present: null,
    revision: null,
  },
  participant_profiling_health_assessment: {
    ...encryptedKeys,
    health_rating: "profilingHealthAssessment",
    health_rating_present: null,
  },
  participation_dsv_amendment: {
    id: null,
    participation_id: null,
    project_id: null,
    kind: "dsvAmendment",
    fully_executed_on: "dsvAmendment",
    old_tg_start: "dsvAmendment",
    new_tg_start: "dsvAmendment",
    old_tg_end: "dsvAmendment",
    new_tg_end: "dsvAmendment",
    confirmed_by: null,
    confirmed_at: "dsvAmendment",
    original_location: "dsvAmendment",
    document_reference: "dsvAmendment",
  },
  participant_channel: {
    id: null,
    project_id: null,
    participation_id: null,
    kind: "portalChannels",
    address: "portalChannels",
    verified_at: "portalChannels",
    verified_by: "portalChannels",
    consent_id: null,
    notice_sent_at: "portalChannels",
    suspended_at: "portalChannels",
    suspension_reason: "portalChannels",
    removed_at: "portalChannels",
    removed_reason: "portalChannels",
  },
  ba_reporting_task: {
    id: null,
    participation_id: null,
    project_id: null,
    reporting_kind: "baReportingTask",
    subject_date: "baReportingTask",
    amendment_id: null,
    status: "baReportingTask",
    created_at: null,
    reported_on: "baReportingTask",
    channel: "baReportingTask",
    reference: "baReportingTask",
    not_required_reason: "baReportingTask",
    decided_by: null,
    decided_at: null,
    superseded_by: null,
    replaces_task_id: null,
    correction_id: null,
  },
  evidence_correction: {
    id: null,
    project_id: null,
    participation_id: null,
    target_kind: "evidenceCorrection",
    action: "evidenceCorrection",
    document_id: null,
    asu_registration_id: null,
    ba_reporting_task_id: null,
    wrong_person: "evidenceCorrection",
    corrected_registered_on: "evidenceCorrection",
    field_key: "evidenceCorrection",
    dsv_offer_id: null,
    signature_paper: "evidenceCorrection",
    signature_kind: "evidenceCorrection",
    corrected_on: "evidenceCorrection",
    original_on: "evidenceCorrection",
    reason: "evidenceCorrection",
    source: "evidenceCorrection",
    retention_class: null,
    status: "evidenceCorrection",
    requested_by: null,
    requested_at: "evidenceCorrection",
    decided_by: null,
    decided_at: "evidenceCorrection",
  },
  participant_reminder: {
    id: null,
    project_id: null,
    participation_id: null,
    batch_id: null,
    channel_id: null,
    consent_id: null,
    requested_by: null,
    kind: "reminderLog",
    message_version: "reminderLog",
    language: "reminderLog",
    channel_kind: "reminderLog",
    requested_at: "reminderLog",
    requested_on: "reminderLog",
    status: "reminderLog",
    cancel_reason: "reminderLog",
    claimed_at: "reminderLog",
    outcome_at: "reminderLog",
    appointment_id: null,
    booking_id: null,
    followed_up_by: null,
    followed_up_method: "reminderLog",
    followed_up_at: "reminderLog",
  },
  appointment_booking: {
    id: null,
    project_id: null,
    participation_id: null,
    appointment_id: "appointmentBookings",
    origin: "appointmentBookings",
    status: "appointmentBookings",
    cancel_reason: "appointmentBookings",
    booked_by: null,
    booked_at: "appointmentBookings",
    cancelled_by: null,
    cancelled_at: "appointmentBookings",
    attendance: "appointmentBookings",
    attendance_recorded_by: null,
    attendance_recorded_at: "appointmentBookings",
    after_close_reason: "appointmentBookings",
    informed_basis_by: null,
    informed_basis_at: "appointmentBookings",
    conflict_escalated_by: null,
    conflict_escalated_at: "appointmentBookings",
    conflict_resolution: "appointmentBookings",
    conflict_resolved_by: null,
    conflict_resolved_at: "appointmentBookings",
    attendance_superseded_by: null,
    attendance_superseded_at: "appointmentBookings",
    follow_up_of: "appointmentBookings",
    missed_resolution: "appointmentBookings",
    missed_resolved_by: null,
    missed_resolved_at: "appointmentBookings",
  },
};

/**
 * Participant-data tables without participant fields: the audit log holds ids and codes only; the
 * saved column mappings hold keyed hashes of header cells, which only a data row picked as the
 * header would make pseudonymised values of a person, never a field of a participation; the
 * assignments hold which consultant a participation is assigned to, ids and dates only (Q62).
 */
const withoutFields = new Set([
  "audit_event",
  "import_column_mapping",
  "participant_assignment",
  "activation_code",
  "privacy_notice_delivery",
  // Ids, states and dates of the account, consents and sessions; the address a one-time code went
  // to is a credential's destination (like the in-person hash of `activation_code`), stripped with
  // it, not the participant's channel.
  "participant_account",
  "consent_record",
  "one_time_code_challenge",
  "participant_session",
  "self_service_notice_acknowledgement",
  "assisted_mode",
  // Documents aren't fields: their files and metadata are classified by the document type catalog.
  "document",
  "document_link",
  "export_link",
  // A generated form's provenance: the declarations it holds are those the form printed, part of
  // the generated document (data-protection.md, generated forms), not the pending fields.
  "form_generation",
  // The offered paper's provenance, deadline and printed terms (process-and-lifecycle.md, DSV offers).
  "dsv_offer",
  "dsv_contract",
  "entry_clarification",
  "entry_clarification_step",
  "dsv_customer_notice",
  "tg_entry_reconciliation",
  "tg_entry_reconciliation_step",
  // A legal hold: its scope, reason code and basis (data-protection.md, legal holds), no field.
  "legal_hold",
  "dsv_scan_signature",
  // The declarations as signed: the paper's values, not the pending fields (ba-forms.md,
  // declarations to the BA).
  "signed_declaration",
]);

/**
 * Fields with a retention class that no table stores yet, e.g. an encrypted field whose table
 * comes with its own write path (data-protection.md, self-service). Each leaves this list when a
 * column stores it; none waits now.
 */
export const notYetStored: ReadonlySet<string> = new Set();

const dataClassRank: Record<DataClass, number> = {
  aggregated: 0,
  internal: 1,
  confidential: 2,
  special_category: 3,
  highly_confidential: 3,
};

/**
 * Returns one message per problem (data-protection.md, retention; ADR-0008): every table holding
 * participant data classifies all its columns; every field a column stores is catalogued, stored as
 * its catalog entry says (a special-category or highly confidential field only in a ciphertext
 * column, `bytea`, written by the encryption functions; no other field there), not above
 * the table's data class and of the table's retention class, so a table holds one retention class
 * only (ADR-0008); and every field with a retention class is stored by some column.
 */
export function checkFieldColumns(
  schemaTables: PgTable[] = tables,
  columns: Record<string, Record<string, string | null>> = fieldColumns,
  catalog: Record<string, CatalogEntry> = dataCatalog,
  fields: readonly FieldEntry[] = fieldCatalog,
  unstored: ReadonlySet<string> = notYetStored,
): string[] {
  const problems: string[] = [];
  const configs = schemaTables.map((t) => getTableConfig(t));
  for (const config of configs) {
    const holds = catalog[config.name]?.holdsParticipantData;
    if (holds && !withoutFields.has(config.name) && !columns[config.name]) {
      problems.push(`${config.name}: holds participant data but its columns aren't classified`);
    }
  }
  const stored = new Set<string>();
  for (const [name, mapping] of Object.entries(columns)) {
    const config = configs.find((c) => c.name === name);
    const entry = catalog[name];
    if (!config || !entry) {
      problems.push(`${name}: not a catalogued table`);
      continue;
    }
    const names = config.columns.map((c) => c.name);
    for (const column of Object.keys(mapping)) {
      if (!names.includes(column)) problems.push(`${name}.${column}: not in the table`);
    }
    for (const column of config.columns) {
      const at = `${name}.${column.name}`;
      const key = mapping[column.name];
      if (key === null) continue;
      const field = fields.find((f) => f.key === key);
      const encrypted = column.getSQLType() === "bytea";
      if (key === undefined) problems.push(`${at}: not classified`);
      else if (!field) problems.push(`${at}: not a field of the catalog`);
      else if (field.storage === "encrypted_column" && !encrypted) {
        problems.push(`${at}: needs encrypted storage`);
      } else if (field.storage === "column" && encrypted) {
        problems.push(`${at}: a ciphertext column for a plain field`);
      } else if (dataClassRank[field.dataClass] > dataClassRank[entry.dataClass]) {
        problems.push(`${at}: data class above the table's`);
      } else if (
        // A table with a class per row (its target's, `evidence_correction`) stores the field
        // under each row's class.
        entry.retentionClass !== perRowRetention &&
        field.retentionClass !== entry.retentionClass
      ) {
        problems.push(`${at}: retention class differs`);
      } else stored.add(field.key);
    }
  }
  for (const field of fields) {
    if (field.retentionClass && !stored.has(field.key) && !unstored.has(field.key)) {
      problems.push(`${field.key}: has a retention class but no column stores it`);
    }
    if (unstored.has(field.key) && stored.has(field.key)) {
      problems.push(`${field.key}: stored, so no longer "not yet stored"`);
    }
  }
  return problems;
}

function isProjectScoped(config: ReturnType<typeof getTableConfig>): boolean {
  const column = config.columns.find((c) => c.name === "project_id");
  if (!column || column.getSQLType() !== "uuid" || !column.notNull) return false;
  return config.foreignKeys.some((fk) => {
    const { columns, foreignTable, foreignColumns } = fk.reference();
    return (
      columns.length === 1 &&
      columns[0] === column &&
      getTableConfig(foreignTable).name === "project" &&
      foreignColumns[0]?.name === "id"
    );
  });
}
