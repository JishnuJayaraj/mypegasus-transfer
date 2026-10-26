import { getTableConfig, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { documentTypeCatalog, fieldCatalog, fieldEntry } from "@transfer/domain";
import {
  checkDataCatalog,
  checkFieldColumns,
  notYetStored,
  dataCatalog,
  fieldColumns,
  retentionPeriods,
  type CatalogEntry,
} from "./data-catalog";
import { project, tables } from "./schema";

const participantEntry: CatalogEntry = {
  retentionClass: "participation_record",
  dataClass: "confidential",
  holdsParticipantData: true,
};

// Marked as participant data, but has no project_id: must fail (ADR-0002).
const fixtureWithoutProjectId = pgTable("fixture_note", {
  id: uuid("id").primaryKey(),
  note: text("note"),
});

const fixtureWithNullableProjectId = pgTable("fixture_nullable", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").references(() => project.id),
});

const fixtureWithoutForeignKey = pgTable("fixture_no_fk", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull(),
});

const fixtureScoped = pgTable("fixture_scoped", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => project.id),
});

const entry = (retentionClass: string, dataClass: string, holdsParticipantData = false) => ({
  retentionClass,
  dataClass,
  holdsParticipantData,
});

const asParticipantData = (name: string) => ({
  ...dataCatalog,
  [name]: { ...dataCatalog[name]!, holdsParticipantData: true },
});

describe("data catalog", () => {
  it("covers every table in the schema, and the schema is fine", () => {
    expect(checkDataCatalog(tables, dataCatalog)).toEqual([]);
  });

  it("classifies every table (Q58, Q59, Q141)", () => {
    expect(dataCatalog).toEqual({
      project: entry("project_master", "internal"),
      staff_user: entry("staff_account", "confidential"),
      // Slice 3 (Q122)
      staff_session: entry("access_credential", "internal"),
      staff_audit_event: entry("audit_log", "internal"),
      // Slice 3 (PR 3c, Q62, Q126)
      region: entry("reference_data", "internal"),
      staff_org_role: entry("staff_account", "internal"),
      participant_assignment: entry("participation_record", "internal", true),
      project_membership: entry("project_master", "internal"),
      project_entry_wave: entry("project_master", "internal"),
      participation: entry("participation_record", "confidential", true),
      profiling_exception_request: entry("participation_record", "confidential", true),
      participant_identity: entry("participation_record", "confidential", true),
      participant_details: entry("personnel_file", "confidential", true),
      // Slice 4a (Q138, Q140, Q141)
      participant_profile: entry("personnel_file", "confidential", true),
      participant_identifier_data: entry("participation_record", "highly_confidential", true),
      participant_residence_social_data: entry("personnel_file", "highly_confidential", true),
      participant_health_data: entry("health_record", "special_category", true),
      // Slice 6 (Q88, Q192, Q193): the profiling record
      participant_profiling: entry("personnel_file", "confidential", true),
      profiling_session: entry("participation_record", "confidential", true),
      participant_profiling_assessment: entry("personnel_file", "highly_confidential", true),
      participant_profiling_health_assessment: entry("health_record", "special_category", true),
      self_service_notice_acknowledgement: entry("personnel_file", "internal", true),
      // Slice 3 (Q122)
      activation_code: entry("access_credential", "confidential", true),
      privacy_notice_delivery: entry("personnel_file", "internal", true),
      // Slice 3 (Q122, Q123)
      participant_account: entry("personnel_file", "internal", true),
      consent_record: entry("personnel_file", "confidential", true),
      participant_channel: entry("personnel_file", "confidential", true),
      one_time_code_challenge: entry("access_credential", "confidential", true),
      participant_session: entry("access_credential", "internal", true),
      // Slice 4a (Q136)
      assisted_mode: entry("access_credential", "internal", true),
      // Slice 4b (Q145, Q147): a document's class is its type's, per row.
      document: entry("by_document_type", "confidential", true),
      document_link: entry("access_credential", "internal", true),
      participant_reminder: entry("personnel_file", "internal", true),
      // Slice 5b (Q58, Q166): appointments are project data, bookings personnel file.
      appointment: entry("project_master", "internal"),
      appointment_booking: entry("personnel_file", "internal", true),
      document_type_policy: entry("reference_data", "internal"),
      // Slice 5 (Q157): the audit history's reference tables
      audit_event_projection: entry("reference_data", "internal"),
      role_field_knowledge: entry("reference_data", "internal"),
      field_access_category: entry("reference_data", "internal"),
      audit_event: entry("audit_log", "confidential", true),
      lifecycle_edge: entry("reference_data", "internal"),
      job_run: entry("reference_data", "internal"),
      config_template_version: entry("reference_data", "internal"),
      project_template_pin: entry("project_master", "internal"),
      project_config_override: entry("project_master", "internal"),
      config_relaxation_request: entry("project_master", "internal"),
      // Round 33: possibly pseudonymised participant data, still kept with the project.
      import_column_mapping: entry("project_master", "confidential", true),
      participation_dsv_amendment: entry("participation_record", "confidential", true),
      ba_reporting_task: entry("participation_record", "confidential", true),
    });
  });

  it("scopes the pins and overrides by a project_id FK; only the global template versions have none", () => {
    expect(checkDataCatalog(tables, asParticipantData("project_template_pin"))).toEqual([]);
    expect(checkDataCatalog(tables, asParticipantData("project_config_override"))).toEqual([]);
    expect(checkDataCatalog(tables, asParticipantData("config_relaxation_request"))).toEqual([]);
    expect(checkDataCatalog(tables, asParticipantData("config_template_version"))).toHaveLength(1);
  });

  it("leaves every period with personal data unset until the DPO confirms it (Q3, Q58, Q59, Q77, Q122, Q141)", () => {
    expect(retentionPeriods).toEqual({
      project_master: "unset",
      staff_account: "unset",
      participation_record: "unset",
      personnel_file: "unset",
      health_record: "unset",
      audit_log: "unset",
      access_credential: "unset",
      evidence_set: "unset",
      reference_data: "never",
    });
  });

  it("knows the class of every document type, and keeps a class per row only beside its column", () => {
    for (const { retentionClass } of documentTypeCatalog.types) {
      expect(Object.keys(retentionPeriods)).toContain(retentionClass);
    }
    const withoutColumn = {
      ...dataCatalog,
      project: { ...dataCatalog.project!, retentionClass: "by_document_type" },
    };
    expect(checkDataCatalog(tables, withoutColumn)).toEqual([
      "project: a class per row needs a retention_class column",
    ]);
    const unscoped = pgTable("fixture_rows", {
      id: uuid("id").primaryKey(),
      retentionClass: text("retention_class"),
    });
    const catalog = {
      ...dataCatalog,
      fixture_rows: { ...participantEntry, retentionClass: "by_document_type" },
    };
    expect(checkDataCatalog([...tables, unscoped], catalog)).toEqual([
      "fixture_rows: holds participant data but has no project_id uuid not null FK to project",
    ]);
  });

  it("fails for an unknown retention class", () => {
    const catalog = {
      ...dataCatalog,
      project: { ...dataCatalog.project!, retentionClass: "forever" },
    };
    expect(checkDataCatalog(tables, catalog)).toEqual(["project: unknown retention class forever"]);
  });

  it("fails for a table that is missing from the catalog", () => {
    expect(checkDataCatalog([...tables, fixtureScoped], dataCatalog)).toEqual([
      "fixture_scoped: missing from the data catalog",
    ]);
  });

  it("fails for a catalog entry without a table", () => {
    const withoutStaffUser = tables.filter((t) => getTableConfig(t).name !== "staff_user");
    expect(checkDataCatalog(withoutStaffUser, dataCatalog)).toEqual([
      "staff_user: in the data catalog but not in the schema",
    ]);
  });

  it("fails for participant data without project_id", () => {
    const catalog = { ...dataCatalog, fixture_note: participantEntry };
    expect(checkDataCatalog([...tables, fixtureWithoutProjectId], catalog)).toEqual([
      "fixture_note: holds participant data but has no project_id uuid not null FK to project",
    ]);
  });

  it.each([fixtureWithNullableProjectId, fixtureWithoutForeignKey])(
    "fails for participant data with a nullable or unreferenced project_id",
    (table) => {
      const catalog = { ...dataCatalog, [getTableConfig(table).name]: participantEntry };
      expect(checkDataCatalog([...tables, table], catalog)).toHaveLength(1);
    },
  );

  it("accepts participant data scoped by a project_id FK", () => {
    const catalog = { ...dataCatalog, fixture_scoped: participantEntry };
    expect(checkDataCatalog([...tables, fixtureScoped], catalog)).toEqual([]);
  });
});

const withField = (key: string, change: object) =>
  fieldCatalog.map((f) => (f.key === key ? { ...f, ...change } : f));

const check = (
  columns: Record<string, Record<string, string | null>> = fieldColumns,
  fields = fieldCatalog,
) => checkFieldColumns(tables, columns, dataCatalog, fields);
const withColumn = (table: string, column: string, key: string | null | undefined) => {
  const mapping: Record<string, string | null> = { ...fieldColumns[table]! };
  if (key === undefined) delete mapping[column];
  else mapping[column] = key;
  return { ...fieldColumns, [table]: mapping };
};

// data-protection.md, classification and retention (ADR-0008): every column of a table with participant fields is
// classified; each stored field is catalogued, a plain column, not above the table's data class and
// of its retention class; and every field with a retention class is stored by some column.
describe("field columns", () => {
  it("classify every column of the tables with participant fields", () => {
    expect(check()).toEqual([]);
    expect(fieldColumns.participant_details!.address_country).toBe("address");
    expect(fieldColumns.participation!.end_reason).toBe("endReason");
    expect(fieldColumns.profiling_exception_request!.reason_code).toBe(
      "profilingExceptionReasonCode",
    );
  });

  it("fails for a stored field without its table's retention class", () => {
    expect(check(fieldColumns, withField("endReason", { retentionClass: undefined }))).toEqual([
      "participation.end_reason: retention class differs",
      "participation.end_reason_secondary: retention class differs",
    ]);
    const mixed = withField("birthDate", { retentionClass: "personnel_file" });
    expect(check(fieldColumns, mixed)).toEqual([
      "participant_identity.birth_date: retention class differs",
      "birthDate: has a retention class but no column stores it",
    ]);
  });

  it("fails for a special-category or highly confidential field, or one above the table's class", () => {
    expect(check(withColumn("participant_details", "phone", "healthRestrictions"))).toEqual([
      "participant_details.phone: needs encrypted storage",
      "phone: has a retention class but no column stores it",
    ]);
    const above = withField("lastName", { dataClass: "highly_confidential" });
    expect(check(fieldColumns, above)).toEqual([
      "participant_identity.last_name: data class above the table's",
      "lastName: has a retention class but no column stores it",
    ]);
  });

  it("fails for an unclassified column, a column not in the table and an unknown field", () => {
    expect(check(withColumn("participation", "end_reason_source", undefined))).toEqual([
      "participation.end_reason_source: not classified",
    ]);
    expect(check(withColumn("participant_details", "fax", "phone"))).toEqual([
      "participant_details.fax: not in the table",
    ]);
    expect(check(withColumn("participant_details", "mobile", "pager"))).toEqual([
      "participant_details.mobile: not a field of the catalog",
      "mobile: has a retention class but no column stores it",
    ]);
    expect(check({ ...fieldColumns, fixture_scoped: {} })).toEqual([
      "fixture_scoped: not a catalogued table",
    ]);
  });

  it("fails for a participant-data table whose columns aren't classified", () => {
    const { profiling_exception_request: _, ...rest } = fieldColumns;
    expect(check(rest)).toEqual([
      "profiling_exception_request: holds participant data but its columns aren't classified",
      "profilingExceptionReasonCode: has a retention class but no column stores it",
    ]);
  });

  it("fails for a retention class on a field no column stores", () => {
    const unstored = withField("knowledgeDate", { retentionClass: "personnel_file" });
    expect(check(fieldColumns, unstored)).toEqual([
      "knowledgeDate: has a retention class but no column stores it",
    ]);
  });

  it("lets a classified field wait for its encrypted table, until a column stores it", () => {
    expect([...notYetStored]).toEqual([]);
    const { participant_health_data: _, ...withoutHealth } = fieldColumns;
    const waiting = new Set(["healthRestrictions", "severeDisability"]);
    expect(checkFieldColumns(tables, withoutHealth, dataCatalog, fieldCatalog, waiting)).toEqual([
      "participant_health_data: holds participant data but its columns aren't classified",
    ]);
    expect(
      checkFieldColumns(tables, fieldColumns, dataCatalog, fieldCatalog, new Set(["gender"])),
    ).toEqual(['gender: stored, so no longer "not yet stored"']);
  });

  it("stores the sensitive fields only in ciphertext columns, and nothing else there", () => {
    expect(fieldEntry("healthRestrictions").storage).toBe("encrypted_column");
    expect(fieldColumns.participant_health_data!.health_restrictions).toBe("healthRestrictions");
    expect(check(withColumn("participant_health_data", "health_restrictions", "gender"))).toEqual([
      "participant_health_data.health_restrictions: a ciphertext column for a plain field",
      "healthRestrictions: has a retention class but no column stores it",
    ]);
  });
});
