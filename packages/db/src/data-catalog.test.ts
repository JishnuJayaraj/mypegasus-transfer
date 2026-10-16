import { getTableConfig, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { checkDataCatalog, dataCatalog, retentionPeriods, type CatalogEntry } from "./data-catalog";
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

describe("data catalog", () => {
  it("covers every table in the schema, and the schema is fine", () => {
    expect(checkDataCatalog(tables, dataCatalog)).toEqual([]);
  });

  it("classifies every table as planned (Q58, Q59; AC-42, plan 5.10)", () => {
    expect(dataCatalog).toEqual({
      project: entry("project_master", "internal"),
      staff_user: entry("staff_account", "confidential"),
      project_entry_wave: entry("project_master", "internal"),
      participation: entry("participation_record", "confidential", true),
      profiling_exception_request: entry("participation_record", "confidential", true),
      audit_event: entry("audit_log", "confidential", true),
      lifecycle_edge: entry("reference_data", "internal"),
    });
  });

  it("leaves every period with personal data unset until the DPO confirms it (Q3, Q58, Q59, Q77)", () => {
    expect(retentionPeriods).toEqual({
      project_master: "unset",
      staff_account: "unset",
      participation_record: "unset",
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
