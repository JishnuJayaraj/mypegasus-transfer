import { describe, expect, it } from "vitest";
import { planImport, type ExistingParticipant } from "./plan";
import type { ImportValues, ValidatedRow } from "./rows";
import type { ImportTarget } from "./targets";

// Slice 2 plan 5.11 (AC-25; R6): the duplicate and update plan. Synthetic values only (D8).
const person = (number: string, more: ImportValues = {}): ImportValues => ({
  personnelNumber: number,
  lastName: "Mustermann",
  firstName: `Person ${number}`,
  birthDate: "1970-02-01",
  ...more,
});
const address = {
  addressStreet: "Musterstraße 1",
  addressPostalCode: "99999",
  addressCity: "Beispielstadt",
  addressCountry: "DE",
};
const row = (
  n: number,
  values: ImportValues,
  issues: ValidatedRow["issues"] = [],
): ValidatedRow => ({
  row: n,
  values,
  issues,
});
const existing = (id: string, values: ImportValues, terminal = false): ExistingParticipant => ({
  participationId: id,
  terminal,
  values: values as ExistingParticipant["values"],
});
const mapped = new Set<ImportTarget>([
  "personnelNumber",
  "lastName",
  "firstName",
  "birthDate",
  "addressStreet",
  "addressPostalCode",
  "addressCity",
  "phone",
]);
const codes = (plan: ReturnType<typeof planImport>) =>
  plan.rows.map((r) => [r.outcome, ...r.issues.map((i) => `${i.target}:${i.code}`)]);

describe("planImport (5.11, AC-25)", () => {
  it("creates new rows and counts the outcomes", () => {
    const plan = planImport({ rows: [row(2, person("BSP-0001"))], mapped, existing: [] });
    expect(plan).toEqual({
      rows: [{ row: 2, outcome: "create", issues: [] }],
      counts: { create: 1, update: 0, unchanged: 0, skip: 0, error: 0 },
      missing: 0,
    });
  });

  it("refuses a Personalnummer twice in the file on both rows, and rows with errors", () => {
    const error = {
      row: 4,
      target: "lastName" as const,
      code: "too_long" as const,
      severity: "error" as const,
    };
    const plan = planImport({
      rows: [
        row(2, person("BSP-0001")),
        row(3, person("BSP-0001", { firstName: "Andere" })),
        row(4, person("BSP-0002"), [error]),
        row(5, {}, [{ ...error, row: 5, target: "personnelNumber", code: "required_missing" }]),
      ],
      mapped,
      existing: [],
    });
    expect(codes(plan)).toEqual([
      ["error", "personnelNumber:duplicate_in_file"],
      ["error", "personnelNumber:duplicate_in_file"],
      ["error", "lastName:too_long"],
      ["error", "personnelNumber:required_missing"],
    ]);
    expect(plan.counts.error).toBe(4);
  });

  it("matches by the exact Personalnummer: update with the changed targets, or unchanged", () => {
    const stored = { ...person("BSP-0001"), ...address, phone: "030 1234567" };
    const plan = planImport({
      rows: [
        row(2, { ...stored, addressCity: "Musterhausen" }),
        row(3, person("BSP-0002", { ...address })),
        // The key is case-sensitive: a different Personalnummer is a new person.
        row(4, person("bsp-0001", { firstName: "Anna" })),
      ],
      mapped,
      existing: [existing("p1", stored), existing("p2", person("BSP-0002", address))],
    });
    expect(plan.rows).toEqual([
      { row: 2, outcome: "update", participationId: "p1", changed: ["addressCity"], issues: [] },
      { row: 3, outcome: "unchanged", participationId: "p2", issues: [] },
      { row: 4, outcome: "create", issues: [] },
    ]);
  });

  it("never clears a stored value: an empty mapped cell keeps it (kept_existing)", () => {
    const stored = {
      ...person("BSP-0001"),
      ...address,
      phone: "030 1234567",
      mobile: "0151 2345678",
    };
    const plan = planImport({
      rows: [row(2, person("BSP-0001"))],
      mapped,
      existing: [existing("p1", stored)],
    });
    // The mobile isn't mapped, so it isn't a kept value; the address is kept as a unit.
    expect(codes(plan)).toEqual([["unchanged", "phone:kept_existing", "address:kept_existing"]]);
    const unmapped = new Set<ImportTarget>([
      "personnelNumber",
      "lastName",
      "firstName",
      "birthDate",
    ]);
    const quiet = planImport({
      rows: [row(2, person("BSP-0001"))],
      mapped: unmapped,
      existing: [existing("p1", stored)],
    });
    expect(codes(quiet)).toEqual([["unchanged"]]);
    const empty = planImport({
      rows: [row(2, person("BSP-0001"))],
      mapped,
      existing: [existing("p1", person("BSP-0001"))],
    });
    expect(codes(empty)).toEqual([["unchanged"]]);
  });

  it("skips a terminal participation", () => {
    const plan = planImport({
      rows: [row(2, person("BSP-0001", { lastName: "Neu" }))],
      mapped,
      existing: [existing("p1", person("BSP-0001"), true)],
    });
    expect(plan.rows).toEqual([
      {
        row: 2,
        outcome: "skip",
        participationId: "p1",
        issues: [{ row: 2, target: null, code: "terminal_not_updated", severity: "warning" }],
      },
    ]);
  });

  it("flags possible duplicates by birth date and names, never merging", () => {
    const twin = { lastName: " mustermann ".trim().toUpperCase(), firstName: "Erika" };
    const plan = planImport({
      rows: [
        row(2, person("BSP-0010", { firstName: "Erika" })),
        row(3, person("BSP-0011", twin)),
        row(4, person("BSP-0012", { firstName: "Max" })),
        row(5, person("BSP-0013", { firstName: "Max", birthDate: "1971-02-01" })),
        // Without a birth date nothing is compared.
        row(6, { personnelNumber: "BSP-0014", lastName: "Mustermann", firstName: "Hans" }),
        row(7, { personnelNumber: "BSP-0015", lastName: "Mustermann", firstName: "Hans" }),
      ],
      mapped,
      existing: [existing("p1", person("BSP-0001", { firstName: "max" }))],
    });
    expect(codes(plan)).toEqual([
      ["create", "null:possible_duplicate"],
      ["create", "null:possible_duplicate"],
      ["create", "null:possible_duplicate"],
      ["create"],
      ["create"],
      ["create"],
    ]);
  });

  it("doesn't compare against rows that won't be created", () => {
    const error = {
      row: 3,
      target: "phone" as const,
      code: "too_long" as const,
      severity: "error" as const,
    };
    const plan = planImport({
      rows: [
        row(2, person("BSP-0010", { firstName: "Erika" })),
        row(3, person("BSP-0011", { firstName: "Erika" }), [error]),
        row(4, person("BSP-0001", { firstName: "Erika" })),
      ],
      mapped,
      existing: [existing("p1", person("BSP-0001"))],
    });
    expect(codes(plan)[0]).toEqual(["create"]);
  });

  it("counts participations missing from the file and leaves them alone", () => {
    const plan = planImport({
      rows: [row(2, person("BSP-0001"))],
      mapped,
      existing: [existing("p1", person("BSP-0001")), existing("p2", person("BSP-0002"))],
    });
    expect(plan.missing).toBe(1);
    expect(plan.rows.map((r) => r.participationId)).toEqual(["p1"]);
  });
});
