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
  // 3 years; pseudonymised when the subject's data is deleted; evidence-set entries follow the
  // evidence set (verify, Q3).
  audit_log: "unset",
  // Q122 (assumed): sessions (and from 3d codes and one-time challenges) are deleted, or stripped of
  // their hashes and addresses, 30 days after use, expiry, lock, revocation or end; a legal hold
  // never keeps a secret usable.
  access_credential: "unset",
  // No personal data: the retention job never touches it.
  reference_data: "never",
} as const;

export const dataCatalog: Record<string, CatalogEntry> = {
  project: { retentionClass: "project_master", dataClass: "internal", holdsParticipantData: false },
  staff_user: {
    retentionClass: "staff_account",
    dataClass: "confidential",
    holdsParticipantData: false,
  },
  // Staff sessions (Slice 3, D2): a token's SHA-256, the staff user, the times; never the token.
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
  // Who holds which project role (D6); staff ids only, no participant data.
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
  // Person data (5.2, 5.10; R8, Q105): identity in the participation record, the rest in the
  // personnel file; one row each per participation.
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
  // Job names, run dates and instants only (plan 5.10).
  job_run: { retentionClass: "reference_data", dataClass: "internal", holdsParticipantData: false },
  // Template versions as released (R27): no personal data, global, never deleted.
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
  // participant data (5.2, AC-39).
  config_relaxation_request: {
    retentionClass: "project_master",
    dataClass: "internal",
    holdsParticipantData: false,
  },
  // Saved import column mappings: the keyed hash of a normalised header and its target, never
  // header text (R7); the application writes them without an audit (D2). Confidential, possibly
  // pseudonymised participant data (R44, round 33): a data row picked as the header would make the
  // hashes keyed hashes of a person's values, which the confirm avoids for a header row that
  // looks like data. No link to a person or participation, so it stays with the project.
  import_column_mapping: {
    retentionClass: "project_master",
    dataClass: "confidential",
    holdsParticipantData: true,
  },
  // DSV amendments and BA reporting tasks (5.2, 5.7; round 32 D3; R41, R42; PR 2h-3): evidence of
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

/**
 * The field-catalog key of each column of the tables holding participant fields (plan 5.2, D8,
 * R8): null for a column that isn't a participant field (keys, references, versions, workflow
 * metadata). The address parts and the country are the field `address` (round 32). Every column of
 * these tables is classified here, so a new column needs a decision.
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
    created_at: null,
    updated_at: null,
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
};

/**
 * Participant-data tables without participant fields: the audit log holds ids and codes only; the
 * saved column mappings hold keyed hashes of header cells, which only a data row picked as the
 * header would make pseudonymised values of a person (R44), never a field of a participation; the
 * assignments hold which consultant a participation is assigned to, ids and dates only (Q62).
 */
const withoutFields = new Set([
  "audit_event",
  "import_column_mapping",
  "participant_assignment",
  "activation_code",
  "privacy_notice_delivery",
]);

const dataClassRank: Record<DataClass, number> = {
  aggregated: 0,
  internal: 1,
  confidential: 2,
  special_category: 3,
  highly_confidential: 3,
};

/**
 * Returns one message per problem (AC-21; review of PR #45): every table holding participant data
 * classifies all its columns; every field a column stores is catalogued, stored as a plain column
 * (no special-category or highly confidential field without encryption), not above the table's
 * data class and of the table's retention class, so a table holds one retention class only
 * (ADR-0008); and every field with a retention class is stored by some column.
 */
export function checkFieldColumns(
  schemaTables: PgTable[] = tables,
  columns: Record<string, Record<string, string | null>> = fieldColumns,
  catalog: Record<string, CatalogEntry> = dataCatalog,
  fields: readonly FieldEntry[] = fieldCatalog,
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
    for (const column of names) {
      const at = `${name}.${column}`;
      const key = mapping[column];
      if (key === null) continue;
      const field = fields.find((f) => f.key === key);
      if (key === undefined) problems.push(`${at}: not classified`);
      else if (!field) problems.push(`${at}: not a field of the catalog`);
      else if (field.storage !== "column") problems.push(`${at}: needs encrypted storage`);
      else if (dataClassRank[field.dataClass] > dataClassRank[entry.dataClass]) {
        problems.push(`${at}: data class above the table's`);
      } else if (field.retentionClass !== entry.retentionClass) {
        problems.push(`${at}: retention class differs`);
      } else stored.add(field.key);
    }
  }
  for (const field of fields) {
    if (field.retentionClass && !stored.has(field.key)) {
      problems.push(`${field.key}: has a retention class but no column stores it`);
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
