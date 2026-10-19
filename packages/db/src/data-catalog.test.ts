import { getTableConfig, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { fieldCatalog } from "@transfer/domain";
import {
  checkDataCatalog,
  checkPersonDataColumns,
  dataCatalog,
  personDataColumns,
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
    });
  });

  it("scopes the pins and overrides by a project_id FK; only the global template versions have none (R27, AC-39)", () => {
    expect(checkDataCatalog(tables, asParticipantData("project_template_pin"))).toEqual([]);
    expect(checkDataCatalog(tables, asParticipantData("project_config_override"))).toEqual([]);
    expect(checkDataCatalog(tables, asParticipantData("config_relaxation_request"))).toEqual([]);
    expect(checkDataCatalog(tables, asParticipantData("config_template_version"))).toHaveLength(1);
  });

  it("leaves every period with personal data unset until the DPO confirms it (Q3, Q58, Q59, Q77)", () => {
    expect(retentionPeriods).toEqual({
      project_master: "unset",
      staff_account: "unset",
      participation_record: "unset",
      personnel_file: "unset",
      audit_log: "unset",
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

// Plan 5.2 (D8, R8; AC-21): each person-data column is a field of the catalog, stored as a plain
// column, of its table's data class and retention class.
describe("person-data columns", () => {
  it("map to catalogued plain fields of the table's classes", () => {
    expect(checkPersonDataColumns()).toEqual([]);
    expect(Object.keys(personDataColumns.participant_details!)).toContain("address_country");
  });

  it("fails for a special-category or highly confidential field", () => {
    const columns = {
      ...personDataColumns,
      participant_details: {
        ...personDataColumns.participant_details!,
        phone: "healthRestrictions",
      },
    };
    expect(checkPersonDataColumns(tables, columns)).toEqual([
      "participant_details.phone: needs encrypted storage",
    ]);
  });

  it("fails for a missing or different retention class (no mixed table)", () => {
    expect(
      checkPersonDataColumns(
        tables,
        personDataColumns,
        dataCatalog,
        withField("phone", { retentionClass: undefined }),
      ),
    ).toEqual(["participant_details.phone: retention class differs"]);
    const mixed = withField("birthDate", { retentionClass: "personnel_file" });
    expect(checkPersonDataColumns(tables, personDataColumns, dataCatalog, mixed)).toEqual([
      "participant_identity.birth_date: retention class differs",
    ]);
  });

  it("fails for a different data class, an unmapped column and a column not in the table", () => {
    const internal = withField("lastName", { dataClass: "internal" });
    expect(checkPersonDataColumns(tables, personDataColumns, dataCatalog, internal)).toEqual([
      "participant_identity.last_name: data class differs",
    ]);
    const { phone: _phone, ...rest } = personDataColumns.participant_details!;
    const columns = {
      participant_details: { ...rest, fax: "phone" },
      fixture_scoped: {},
    };
    expect(checkPersonDataColumns(tables, columns)).toEqual([
      "participant_details.fax: not in the table",
      "participant_details.phone: not a field of the catalog",
      "fixture_scoped: not a catalogued table",
    ]);
  });
});
