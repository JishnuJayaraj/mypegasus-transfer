import type { DataClass } from "@transfer/domain";
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
} as const;

export const dataCatalog: Record<string, CatalogEntry> = {
  project: { retentionClass: "project_master", dataClass: "internal", holdsParticipantData: false },
  staff_user: {
    retentionClass: "staff_account",
    dataClass: "confidential",
    holdsParticipantData: false,
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
