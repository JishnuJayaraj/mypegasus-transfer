import { fieldCatalog, type DataClass, type FieldEntry } from "@transfer/domain";
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
 * Retention periods of the classes. `unset` means no deletion job may touch the class yet;
 * the retention job (Slice 7) must refuse to run for it.
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
  // No personal data: the retention job never touches it.
  reference_data: "never",
} as const;

/**
 * The class of a table whose rows carry their own (ADR-0008, per item): `document`, each row its
 * type's class from the document type catalog, in its `retention_class` column.
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
  // tombstone), its wrapped key and content hash, which the runtime role can't select; each row of
  // its type's class.
  document: {
    retentionClass: perRowRetention,
    dataClass: "confidential",
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
  },
  participant_health_data: {
    ...encryptedKeys,
    health_restrictions: "healthRestrictions",
    health_restrictions_present: null,
    severe_disability: "severeDisability",
    severe_disability_present: null,
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
      } else if (field.retentionClass !== entry.retentionClass) {
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
