import { getTableConfig, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { fieldCatalog } from "@transfer/domain";
import {
  checkDataCatalog,
  checkFieldColumns,
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

  it("classifies every table as planned (Q58, Q59; AC-42, plan 5.10)", () => {
    expect(dataCatalog).toEqual({
      project: entry("project_master", "internal"),
      staff_user: entry("staff_account", "confidential"),
      // Slice 3 (PR 3b, D2, D6, Q122)
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
      audit_event: entry("audit_log", "confidential", true),
      lifecycle_edge: entry("reference_data", "internal"),
      job_run: entry("reference_data", "internal"),
      config_template_version: entry("reference_data", "internal"),
      project_template_pin: entry("project_master", "internal"),
      project_config_override: entry("project_master", "internal"),
      config_relaxation_request: entry("project_master", "internal"),
      // R44, round 33: possibly pseudonymised participant data, still kept with the project.
      import_column_mapping: entry("project_master", "confidential", true),
      participation_dsv_amendment: entry("participation_record", "confidential", true),
      ba_reporting_task: entry("participation_record", "confidential", true),
    });
  });

  it("scopes the pins and overrides by a project_id FK; only the global template versions have none (R27, AC-39)", () => {
    expect(checkDataCatalog(tables, asParticipantData("project_template_pin"))).toEqual([]);
    expect(checkDataCatalog(tables, asParticipantData("project_config_override"))).toEqual([]);
    expect(checkDataCatalog(tables, asParticipantData("config_relaxation_request"))).toEqual([]);
    expect(checkDataCatalog(tables, asParticipantData("config_template_version"))).toHaveLength(1);
  });

  it("leaves every period with personal data unset until the DPO confirms it (Q3, Q58, Q59, Q77, Q122)", () => {
    expect(retentionPeriods).toEqual({
      project_master: "unset",
      staff_account: "unset",
      participation_record: "unset",
      personnel_file: "unset",
      audit_log: "unset",
      access_credential: "unset",
      reference_data: "never",
    });
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

// Plan 5.2 (D8, R8; AC-21; review of PR #45): every column of a table with participant fields is
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
});
