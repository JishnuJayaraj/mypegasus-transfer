import type { ImportPlan, PlannedRow } from "./plan";
import type { ImportIssueCode } from "./targets";

// The PL's decisions on a confirmed import (Slice 2 plan 5.11, AC-26). Pure: the confirm checks
// them against the plan it just re-made under the project lock, so a decision can never refer to
// a row of another plan. The routes' input schema (contract.ts) only checks their shape.

/** What the PL decided: create or skip each possible duplicate; the warnings confirmed as seen. */
export type ImportDecisions = {
  confirmWarnings: boolean;
  /** By the row number in the file, as a JSON object key. */
  possibleDuplicates: Readonly<Record<string, "create" | "skip">>;
};

export type ImportDecisionIssueCode =
  | "duplicate_undecided"
  | "decision_without_duplicate"
  | "warnings_unconfirmed";
export type ImportDecisionIssue = { code: ImportDecisionIssueCode; row: number | null };

const isDuplicate = (row: PlannedRow) =>
  row.issues.some((issue) => issue.code === "possible_duplicate");

/** The distinct warning codes of a row, in the order they were raised. */
const warningCodes = (row: PlannedRow): ImportIssueCode[] => [
  ...new Set(row.issues.filter((i) => i.severity === "warning").map((i) => i.code)),
];

/** Whether the PL decided to skip the row (only a possible duplicate can be). */
const skipped = (row: PlannedRow, decisions: ImportDecisions) =>
  decisions.possibleDuplicates[String(row.row)] === "skip";

/**
 * Checks the decisions against the plan (5.11): every `possible_duplicate` row decided create or
 * skip, no decision for any other row, and the warnings confirmed whenever a row that will be
 * written or matched still has one (the duplicate warning is the row's own decision, and the
 * warnings of a row the PL skips are moot). Every issue is listed, in row order.
 */
export function checkImportDecisions(
  plan: ImportPlan,
  decisions: ImportDecisions,
): { ok: true } | { ok: false; issues: ImportDecisionIssue[] } {
  const issues: ImportDecisionIssue[] = [];
  const duplicates = new Set(plan.rows.filter(isDuplicate).map((row) => row.row));
  for (const row of duplicates) {
    if (decisions.possibleDuplicates[String(row)] === undefined) {
      issues.push({ code: "duplicate_undecided", row });
    }
  }
  const stray = Object.keys(decisions.possibleDuplicates)
    .map(Number)
    .filter((row) => !duplicates.has(row))
    .toSorted((a, b) => a - b);
  for (const row of stray) issues.push({ code: "decision_without_duplicate", row });
  issues.sort((a, b) => (a.row as number) - (b.row as number));

  const unconfirmed = plan.rows.some(
    (row) =>
      !skipped(row, decisions) && warningCodes(row).some((code) => code !== "possible_duplicate"),
  );
  if (unconfirmed && !decisions.confirmWarnings) {
    issues.push({ code: "warnings_unconfirmed", row: null });
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * The warnings the PL confirmed, per row of the file, for the `warning_confirmed` events (5.11):
 * the distinct codes of every row that isn't an error and wasn't skipped by decision; the
 * duplicate warning stands for the decision to create it anyway; the others count only once the
 * PL confirmed them. Rows without such a warning are absent.
 */
export function warningsToAudit(
  plan: ImportPlan,
  decisions: ImportDecisions,
): { row: number; codes: ImportIssueCode[] }[] {
  return plan.rows
    .filter((row) => row.outcome !== "error" && !skipped(row, decisions))
    .map((row) => ({
      row: row.row,
      codes: warningCodes(row).filter(
        (code) => code === "possible_duplicate" || decisions.confirmWarnings,
      ),
    }))
    .filter(({ codes }) => codes.length > 0);
}
