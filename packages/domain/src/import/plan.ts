import { z } from "zod";
import type { ImportValues, ValidatedRow } from "./rows";
import { addressParts, type ImportIssue, type ImportTarget } from "./targets";

// The import plan (Slice 2 plan 5.11; R6; round 32): what confirming would do with each row.
// Pure; matched by the exact Personalnummer, never fuzzy, never an automatic merge.

export const ImportRowOutcome = z.enum(["create", "update", "unchanged", "skip", "error"]);
export type ImportRowOutcome = z.infer<typeof ImportRowOutcome>;

/** A participation of the project with its stored person data. */
export type ExistingParticipant = {
  participationId: string;
  terminal: boolean;
  values: ImportValues & { personnelNumber: string };
};

export type PlannedRow = {
  row: number;
  outcome: ImportRowOutcome;
  /** The matched participation (`update`, `unchanged`, `skip`). */
  participationId?: string;
  /** For an update, the targets whose value changes. */
  changed?: ImportTarget[];
  issues: ImportIssue[];
};

export type ImportPlan = {
  rows: PlannedRow[];
  counts: Record<ImportRowOutcome, number>;
  /** Participations of the project the file doesn't contain: counted, never changed. */
  missing: number;
};

const address = [...addressParts, "addressCountry"] as const;

/** Names compared trimmed and case-insensitively (no fuzzy matching). */
const identityKey = (values: ImportValues) =>
  values.birthDate === undefined || values.lastName === undefined || values.firstName === undefined
    ? undefined
    : [values.birthDate, values.lastName, values.firstName]
        .map((part) => part.normalize("NFC").toLowerCase())
        .join("\u0000");

export function planImport(input: {
  rows: readonly ValidatedRow[];
  /** The targets the mapping has, so an empty cell keeps the stored value (`kept_existing`). */
  mapped: ReadonlySet<ImportTarget>;
  existing: readonly ExistingParticipant[];
}): ImportPlan {
  const byNumber = new Map(input.existing.map((p) => [p.values.personnelNumber, p]));
  const inFile = new Map<string, number>();
  for (const { values } of input.rows) {
    const number = values.personnelNumber;
    if (number !== undefined) inFile.set(number, (inFile.get(number) ?? 0) + 1);
  }
  // Identities of existing participations and of the file's new rows, for possible duplicates.
  const identities = new Map<string, number>();
  const countIdentity = (values: ImportValues) => {
    const key = identityKey(values);
    if (key !== undefined) identities.set(key, (identities.get(key) ?? 0) + 1);
  };
  for (const p of input.existing) countIdentity(p.values);
  const creatable = (r: ValidatedRow) => {
    const number = r.values.personnelNumber;
    return (
      number !== undefined &&
      !byNumber.has(number) &&
      inFile.get(number) === 1 &&
      !r.issues.some((issue) => issue.severity === "error")
    );
  };
  for (const r of input.rows) if (creatable(r)) countIdentity(r.values);

  const rows = input.rows.map((r): PlannedRow => {
    const issues = [...r.issues];
    const number = r.values.personnelNumber;
    if (number !== undefined && (inFile.get(number) as number) > 1) {
      issues.push({
        row: r.row,
        target: "personnelNumber",
        code: "duplicate_in_file",
        severity: "error",
      });
    }
    if (number === undefined || issues.some((issue) => issue.severity === "error")) {
      return { row: r.row, outcome: "error", issues };
    }
    const match = byNumber.get(number);
    if (!match) {
      const key = identityKey(r.values);
      if (key !== undefined && (identities.get(key) as number) > 1) {
        issues.push({ row: r.row, target: null, code: "possible_duplicate", severity: "warning" });
      }
      return { row: r.row, outcome: "create", issues };
    }
    const participationId = match.participationId;
    if (match.terminal) {
      issues.push({ row: r.row, target: null, code: "terminal_not_updated", severity: "warning" });
      return { row: r.row, outcome: "skip", participationId, issues };
    }
    const changed = (Object.keys(r.values) as ImportTarget[]).filter(
      (target) => r.values[target] !== match.values[target],
    );
    for (const target of keptTargets(input.mapped, r.values, match.values)) {
      issues.push({ row: r.row, target, code: "kept_existing", severity: "warning" });
    }
    return changed.length === 0
      ? { row: r.row, outcome: "unchanged", participationId, issues }
      : { row: r.row, outcome: "update", participationId, changed, issues };
  });

  const counts = { create: 0, update: 0, unchanged: 0, skip: 0, error: 0 };
  for (const r of rows) counts[r.outcome] += 1;
  const missing = input.existing.filter((p) => !inFile.has(p.values.personnelNumber)).length;
  return { rows, counts, missing };
}

/**
 * The mapped targets whose cell was empty while a value is stored: the stored value stays. The
 * address is one unit (`address`), since a row has all of it or none.
 */
function keptTargets(
  mapped: ReadonlySet<ImportTarget>,
  values: ImportValues,
  stored: ImportValues,
): (ImportTarget | "address")[] {
  const kept: (ImportTarget | "address")[] = [];
  for (const target of mapped) {
    if ((address as readonly string[]).includes(target)) continue;
    if (values[target] === undefined && stored[target] !== undefined) kept.push(target);
  }
  const addressMapped = addressParts.some((part) => mapped.has(part));
  if (addressMapped && values.addressStreet === undefined && stored.addressStreet !== undefined) {
    kept.push("address");
  }
  return kept;
}
