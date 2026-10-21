import { z } from "zod";
import { checkRecord, type ImportValues, type ValidatedRow } from "./rows";
import type { ContactField } from "../self-service/values";
import { addressParts, type ImportIssue, type ImportTarget } from "./targets";

// The import plan (process-and-lifecycle.md, Import; round 32): what confirming would do with each row.
// Pure; matched by the exact Personalnummer, never fuzzy, never an automatic merge.

export const ImportRowOutcome = z.enum(["create", "update", "unchanged", "skip", "error"]);
export type ImportRowOutcome = z.infer<typeof ImportRowOutcome>;

/** A participation of the project with its stored person data. */
export type ExistingParticipant = {
  participationId: string;
  terminal: boolean;
  values: ImportValues & { personnelNumber: string };
  /** The contact fields the participant wrote, which an import never overwrites (Q112). */
  participantMaintained?: ReadonlySet<ContactField>;
};

/** The import targets of each contact field; the address is one unit (round 32). */
const contactTargets: Record<ContactField, readonly ImportTarget[]> = {
  address: [...addressParts, "addressCountry"],
  phone: ["phone"],
  mobile: ["mobile"],
  privateEmail: ["privateEmail"],
};

/** The targets of the participant-maintained fields. */
const maintainedTargets = (maintained: ReadonlySet<ContactField> = new Set()) =>
  new Set([...maintained].flatMap((field) => contactTargets[field]));

/**
 * The row's values without the participant-maintained ones (Q112): what a confirm writes. The
 * database skips them too.
 */
export function writableValues(
  values: ImportValues,
  maintained?: ReadonlySet<ContactField>,
): ImportValues {
  const skipped = maintainedTargets(maintained);
  return Object.fromEntries(
    Object.entries(values).filter(([target]) => !skipped.has(target as ImportTarget)),
  );
}

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

/** Names compared trimmed and case-insensitively (no fuzzy matching; Q103). */
const identityKey = (values: ImportValues) =>
  values.birthDate === undefined || values.lastName === undefined || values.firstName === undefined
    ? undefined
    : [values.birthDate, values.lastName, values.firstName]
        .map((part) => part.trim().normalize("NFC").toLowerCase())
        .join("\u0000");

const hasError = (issues: readonly ImportIssue[]) =>
  issues.some((issue) => issue.severity === "error");

/**
 * The plan (5.11): the key first (a missing or invalid Personalnummer, or one in several rows, is
 * an error); a match with a terminal participation is skipped whatever else the row holds; then the
 * row's own errors; then the record a confirm would leave (`checkRecord`: the row's values for a
 * new participation, merged over the stored ones for an update, so an empty cell keeps a stored
 * required value); then create, update or unchanged. Possible duplicates are the new rows whose
 * birth date and names match another new row or an existing participation.
 */
export function planImport(input: {
  rows: readonly ValidatedRow[];
  /** The targets the mapping has, so an empty cell keeps the stored value (`kept_existing`). */
  mapped: ReadonlySet<ImportTarget>;
  existing: readonly ExistingParticipant[];
  /** The rules the project relaxed (Q75). */
  relaxedRuleIds: ReadonlySet<string>;
}): ImportPlan {
  const byNumber = new Map(input.existing.map((p) => [p.values.personnelNumber, p]));
  const inFile = new Map<string, number>();
  for (const { values } of input.rows) {
    const number = values.personnelNumber;
    if (number !== undefined) inFile.set(number, (inFile.get(number) ?? 0) + 1);
  }

  const rows = input.rows.map((r): PlannedRow => {
    const { row, values } = r;
    const number = values.personnelNumber;
    if (number === undefined) return { row, outcome: "error", issues: [...r.issues] };
    if ((inFile.get(number) as number) > 1) {
      const duplicate: ImportIssue = {
        row,
        target: "personnelNumber",
        code: "duplicate_in_file",
        severity: "error",
      };
      return { row, outcome: "error", issues: [...r.issues, duplicate] };
    }
    const match = byNumber.get(number);
    if (match?.terminal) {
      const notice: ImportIssue = {
        row,
        target: null,
        code: "terminal_not_updated",
        severity: "warning",
      };
      return { row, outcome: "skip", participationId: match.participationId, issues: [notice] };
    }
    if (hasError(r.issues)) return { row, outcome: "error", issues: [...r.issues] };
    const writable = writableValues(values, match?.participantMaintained);
    const record = checkRecord({
      row,
      values: { ...match?.values, ...writable },
      fromRow: writable,
      relaxedRuleIds: input.relaxedRuleIds,
    });
    const issues = [...r.issues, ...record];
    if (hasError(record)) return { row, outcome: "error", issues };
    if (!match) return { row, outcome: "create", issues };
    const participationId = match.participationId;
    const changed = (Object.keys(writable) as ImportTarget[]).filter(
      (target) => writable[target] !== match.values[target],
    );
    const maintained = maintainedTargets(match.participantMaintained);
    for (const target of keptTargets(input.mapped, values, match.values)) {
      const unit = target === "address" ? contactTargets.address : [target];
      if (unit.some((t) => maintained.has(t))) continue;
      issues.push({ row, target, code: "kept_existing", severity: "warning" });
    }
    // A difference to a value the participant wrote is reported by target, never a value (Q112).
    for (const field of match.participantMaintained ?? []) {
      const targets = contactTargets[field];
      if (targets.some((t) => values[t] !== undefined && values[t] !== match.values[t])) {
        const target = field === "address" ? "address" : (field as ImportTarget);
        issues.push({ row, target, code: "participant_maintained", severity: "warning" });
      }
    }
    return changed.length === 0
      ? { row, outcome: "unchanged", participationId, issues }
      : { row, outcome: "update", participationId, changed, issues };
  });

  // Possible duplicates: the identities of existing participations and of the rows to create.
  const identities = new Map<string, number>();
  const count = (values: ImportValues) => {
    const key = identityKey(values);
    if (key !== undefined) identities.set(key, (identities.get(key) ?? 0) + 1);
  };
  for (const p of input.existing) count(p.values);
  const creates = rows.flatMap((planned, i) =>
    planned.outcome === "create" ? [[planned, input.rows[i]!.values] as const] : [],
  );
  for (const [, values] of creates) count(values);
  for (const [planned, values] of creates) {
    const key = identityKey(values);
    if (key !== undefined && (identities.get(key) as number) > 1) {
      planned.issues.push({
        row: planned.row,
        target: null,
        code: "possible_duplicate",
        severity: "warning",
      });
    }
  }

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
