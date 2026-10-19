import { describe, expect, it } from "vitest";
import { checkImportDecisions, warningsToAudit, type ImportDecisions } from "./decisions";
import type { ImportPlan, PlannedRow } from "./plan";
import type { ImportIssue } from "./targets";

const warning = (row: number, code: ImportIssue["code"]): ImportIssue => ({
  row,
  target: null,
  code,
  severity: "warning",
});

function planOf(rows: PlannedRow[]): ImportPlan {
  return {
    rows,
    counts: { create: 0, update: 0, unchanged: 0, skip: 0, error: 0 },
    missing: 0,
  };
}

const clean: PlannedRow = { row: 2, outcome: "create", issues: [] };
const duplicate: PlannedRow = {
  row: 3,
  outcome: "create",
  issues: [warning(3, "possible_duplicate")],
};
const aged: PlannedRow = {
  row: 4,
  outcome: "create",
  issues: [warning(4, "age_implausible")],
};

describe("checkImportDecisions (AC-26, 5.11)", () => {
  it("accepts a plan without warnings and without decisions", () => {
    const result = checkImportDecisions(planOf([clean]), {
      confirmWarnings: false,
      possibleDuplicates: {},
    });
    expect(result).toEqual({ ok: true });
  });

  it("needs a decision for every possible duplicate", () => {
    const result = checkImportDecisions(planOf([duplicate]), {
      confirmWarnings: false,
      possibleDuplicates: {},
    });
    expect(result).toEqual({
      ok: false,
      issues: [{ code: "duplicate_undecided", row: 3 }],
    });
  });

  it("accepts create and skip as the decision", () => {
    for (const decision of ["create", "skip"] as const) {
      const result = checkImportDecisions(planOf([duplicate]), {
        confirmWarnings: false,
        possibleDuplicates: { "3": decision },
      });
      expect(result).toEqual({ ok: true });
    }
  });

  it("refuses a decision for a row that is no possible duplicate", () => {
    const result = checkImportDecisions(planOf([clean, duplicate]), {
      confirmWarnings: false,
      possibleDuplicates: { "2": "create", "3": "skip", "99": "skip" },
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "decision_without_duplicate", row: 2 },
        { code: "decision_without_duplicate", row: 99 },
      ],
    });
  });

  it("reports the undecided duplicates and the stray decisions together, in row order", () => {
    const result = checkImportDecisions(planOf([duplicate, { ...duplicate, row: 5 }]), {
      confirmWarnings: false,
      possibleDuplicates: { "5": "create", "7": "skip" },
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "duplicate_undecided", row: 3 },
        { code: "decision_without_duplicate", row: 7 },
      ],
    });
  });

  it("needs the warnings confirmed when any other warning remains", () => {
    const decisions = { confirmWarnings: false, possibleDuplicates: {} };
    expect(checkImportDecisions(planOf([aged]), decisions)).toEqual({
      ok: false,
      issues: [{ code: "warnings_unconfirmed", row: null }],
    });
    expect(checkImportDecisions(planOf([aged]), { ...decisions, confirmWarnings: true })).toEqual({
      ok: true,
    });
  });

  it("does not ask to confirm warnings of a row the PL skips", () => {
    const flagged: PlannedRow = {
      row: 6,
      outcome: "create",
      issues: [warning(6, "possible_duplicate"), warning(6, "age_implausible")],
    };
    const result = checkImportDecisions(planOf([flagged]), {
      confirmWarnings: false,
      possibleDuplicates: { "6": "skip" },
    });
    expect(result).toEqual({ ok: true });
  });

  it("asks to confirm a duplicate's other warnings when the PL creates it", () => {
    const flagged: PlannedRow = {
      row: 6,
      outcome: "create",
      issues: [warning(6, "possible_duplicate"), warning(6, "age_implausible")],
    };
    const result = checkImportDecisions(planOf([flagged]), {
      confirmWarnings: false,
      possibleDuplicates: { "6": "create" },
    });
    expect(result).toEqual({ ok: false, issues: [{ code: "warnings_unconfirmed", row: null }] });
  });

  it("accepts a confirmation when there is nothing to confirm", () => {
    const result = checkImportDecisions(planOf([clean]), {
      confirmWarnings: true,
      possibleDuplicates: {},
    });
    expect(result).toEqual({ ok: true });
  });

  it("counts a notice on a skipped terminal participation as a warning to confirm", () => {
    const terminal: PlannedRow = {
      row: 8,
      outcome: "skip",
      participationId: "p",
      issues: [warning(8, "terminal_not_updated")],
    };
    const decisions = { confirmWarnings: false, possibleDuplicates: {} };
    expect(checkImportDecisions(planOf([terminal]), decisions).ok).toBe(false);
  });
});

describe("warningsToAudit", () => {
  it("lists, per participation, the warning codes the PL confirmed", () => {
    const rows: PlannedRow[] = [
      clean,
      { row: 3, outcome: "create", issues: [warning(3, "possible_duplicate")] },
      {
        row: 4,
        outcome: "update",
        participationId: "u",
        changed: ["phone"],
        issues: [warning(4, "kept_existing"), warning(4, "kept_existing")],
      },
      {
        row: 5,
        outcome: "create",
        issues: [warning(5, "possible_duplicate"), warning(5, "age_implausible")],
      },
      {
        row: 6,
        outcome: "skip",
        participationId: "t",
        issues: [warning(6, "terminal_not_updated")],
      },
      { row: 7, outcome: "error", issues: [warning(7, "age_implausible")] },
    ];
    const decisions: ImportDecisions = {
      confirmWarnings: true,
      possibleDuplicates: { "3": "create", "5": "skip" },
    };
    expect(warningsToAudit(planOf(rows), decisions)).toEqual([
      { row: 3, codes: ["possible_duplicate"] },
      { row: 4, codes: ["kept_existing"] },
      { row: 6, codes: ["terminal_not_updated"] },
    ]);
  });

  it("audits nothing before the PL confirmed the warnings", () => {
    const rows: PlannedRow[] = [aged, duplicate];
    expect(
      warningsToAudit(planOf(rows), {
        confirmWarnings: false,
        possibleDuplicates: { "3": "create" },
      }),
    ).toEqual([{ row: 3, codes: ["possible_duplicate"] }]);
  });
});
