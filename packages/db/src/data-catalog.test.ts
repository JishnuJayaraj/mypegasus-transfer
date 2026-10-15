import { getTableConfig, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { checkDataCatalog, dataCatalog, type CatalogEntry } from "./data-catalog";
import { project, tables } from "./schema";

const participantEntry: CatalogEntry = {
  retentionClass: "fixture_participant_data",
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

describe("data catalog", () => {
  it("covers every table in the schema, and the schema is fine", () => {
    expect(checkDataCatalog(tables, dataCatalog)).toEqual([]);
  });

  it("classifies project and staff_user as planned (Q58, Q59)", () => {
    expect(dataCatalog).toEqual({
      project: {
        retentionClass: "project_master",
        dataClass: "internal",
        holdsParticipantData: false,
      },
      staff_user: {
        retentionClass: "staff_account",
        dataClass: "confidential",
        holdsParticipantData: false,
      },
    });
  });

  it("fails for a table that is missing from the catalog", () => {
    expect(checkDataCatalog([...tables, fixtureScoped], dataCatalog)).toEqual([
      "fixture_scoped: missing from the data catalog",
    ]);
  });

  it("fails for a catalog entry without a table", () => {
    expect(checkDataCatalog([project], dataCatalog)).toEqual([
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
