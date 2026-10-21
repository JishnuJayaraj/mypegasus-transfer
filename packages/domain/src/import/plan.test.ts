import { describe, expect, it } from "vitest";
import { planImport, writableValues, type ExistingParticipant } from "./plan";
import { validateRow, type ImportCell, type ImportValues, type ValidatedRow } from "./rows";
import type { ImportTarget } from "./targets";

// The duplicate and update plan (process-and-lifecycle.md, Import). Synthetic values only.
const none = new Set<string>();
const relaxed = new Set([
  "base-import-birthDate",
  "base-import-oldEmploymentEndDate",
  "base-import-address",
]);
const address = {
  addressStreet: "Musterstraße 1",
  addressPostalCode: "99999",
  addressCity: "Beispielstadt",
  addressCountry: "DE",
};
/** A complete record: the names, both dates and the address. */
const person = (number: string, more: ImportValues = {}): ImportValues => ({
  personnelNumber: number,
  lastName: "Mustermann",
  firstName: `Person ${number}`,
  birthDate: "1970-02-01",
  oldEmploymentEndDate: "2027-03-31",
  ...address,
  ...more,
});
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
  "oldEmploymentEndDate",
  "addressStreet",
  "addressPostalCode",
  "addressCity",
  "phone",
]);
const plan = (
  rows: ValidatedRow[],
  stored: ExistingParticipant[] = [],
  options: { mapped?: ReadonlySet<ImportTarget>; relaxedRuleIds?: ReadonlySet<string> } = {},
) =>
  planImport({
    rows,
    existing: stored,
    mapped: options.mapped ?? mapped,
    relaxedRuleIds: options.relaxedRuleIds ?? none,
  });
const codes = (result: ReturnType<typeof planImport>) =>
  result.rows.map((r) => [r.outcome, ...r.issues.map((i) => `${i.target}:${i.code}`)]);
const tooLong = (n: number, target: ImportTarget) =>
  ({ row: n, target, code: "too_long", severity: "error" }) as const;

describe("planImport (5.11, AC-25)", () => {
  it("creates new rows and counts the outcomes", () => {
    expect(plan([row(2, person("BSP-0001"))])).toEqual({
      rows: [{ row: 2, outcome: "create", issues: [] }],
      counts: { create: 1, update: 0, unchanged: 0, skip: 0, error: 0 },
      missing: 0,
    });
  });

  it("refuses a Personalnummer twice in the file on both rows, and rows with errors", () => {
    const result = plan([
      row(2, person("BSP-0001")),
      row(3, person("BSP-0001", { firstName: "Andere" })),
      row(4, person("BSP-0002"), [tooLong(4, "lastName")]),
      row(5, {}, [{ ...tooLong(5, "personnelNumber"), code: "required_missing" }]),
    ]);
    expect(codes(result)).toEqual([
      ["error", "personnelNumber:duplicate_in_file"],
      ["error", "personnelNumber:duplicate_in_file"],
      ["error", "lastName:too_long"],
      ["error", "personnelNumber:required_missing"],
    ]);
    expect(result.counts.error).toBe(4);
  });

  it("requires a complete record for a new participation", () => {
    const bare = { personnelNumber: "BSP-0001", lastName: "Mustermann", firstName: "Erika" };
    expect(codes(plan([row(2, bare)]))).toEqual([
      [
        "error",
        "birthDate:required_missing",
        "oldEmploymentEndDate:required_missing",
        "address:required_missing",
      ],
    ]);
    expect(codes(plan([row(2, bare)], [], { relaxedRuleIds: relaxed }))).toEqual([["create"]]);
  });

  it("matches by the exact Personalnummer: update with the changed targets, or unchanged", () => {
    const stored = person("BSP-0001", { phone: "030 1234567" });
    const result = plan(
      [
        row(2, { ...stored, addressCity: "Musterhausen" }),
        row(3, person("BSP-0002")),
        // The key is case-sensitive: a different Personalnummer is a new person.
        row(4, person("bsp-0001", { firstName: "Anna" })),
      ],
      [existing("p1", stored), existing("p2", person("BSP-0002"))],
    );
    expect(result.rows).toEqual([
      { row: 2, outcome: "update", participationId: "p1", changed: ["addressCity"], issues: [] },
      { row: 3, outcome: "unchanged", participationId: "p2", issues: [] },
      { row: 4, outcome: "create", issues: [] },
    ]);
  });

  // Review of PR #44: an empty cell keeps the stored value, also of a required target.
  it("keeps stored required values for empty cells of a matched row (kept_existing)", () => {
    const stored = person("BSP-0001", { phone: "030 1234567", mobile: "0151 2345678" });
    const result = plan([row(2, { personnelNumber: "BSP-0001" })], [existing("p1", stored)]);
    // The mobile isn't mapped, so it isn't a kept value; the address is kept as a unit.
    expect(codes(result)).toEqual([
      [
        "unchanged",
        "lastName:kept_existing",
        "firstName:kept_existing",
        "birthDate:kept_existing",
        "oldEmploymentEndDate:kept_existing",
        "phone:kept_existing",
        "address:kept_existing",
      ],
    ]);
    const key = new Set<ImportTarget>(["personnelNumber", "lastName", "firstName"]);
    const quiet = plan([row(2, person("BSP-0001"))], [existing("p1", stored)], { mapped: key });
    expect(codes(quiet)).toEqual([["unchanged"]]);
  });

  it("refuses a matched row whose merged record lacks a required value", () => {
    const stored = { personnelNumber: "BSP-0001", lastName: "Mustermann", firstName: "Erika" };
    const result = plan(
      [row(2, { personnelNumber: "BSP-0001", ...address })],
      [existing("p1", stored)],
    );
    expect(codes(result)).toEqual([
      ["error", "birthDate:required_missing", "oldEmploymentEndDate:required_missing"],
    ]);
  });

  it("checks the date pair against the stored date of a matched row", () => {
    const stored = person("BSP-0001");
    const result = plan(
      [row(2, { personnelNumber: "BSP-0001", oldEmploymentEndDate: "1970-01-31" })],
      [existing("p1", stored)],
    );
    expect(codes(result)[0]).toEqual(["error", "oldEmploymentEndDate:end_before_birth"]);
  });

  // Review of PR #44: the terminal status wins over the row's other values.
  it("skips a terminal participation, even when other values of the row are invalid", () => {
    const stored = existing("p1", person("BSP-0001"), true);
    const notice = { row: 2, target: null, code: "terminal_not_updated", severity: "warning" };
    for (const r of [
      row(2, person("BSP-0001", { lastName: "Neu" })),
      row(2, { personnelNumber: "BSP-0001" }, [tooLong(2, "lastName")]),
    ]) {
      expect(plan([r], [stored]).rows).toEqual([
        { row: 2, outcome: "skip", participationId: "p1", issues: [notice] },
      ]);
    }
    // The key stays fail closed: a duplicated Personalnummer is an error, terminal or not.
    const twice = plan([row(2, person("BSP-0001")), row(3, person("BSP-0001"))], [stored]);
    expect(twice.counts).toMatchObject({ error: 2, skip: 0 });
  });

  it("flags possible duplicates by birth date and trimmed, case-insensitive names", () => {
    const twin = { lastName: " MUSTERMANN ", firstName: "Erika " };
    const result = plan(
      [
        row(2, person("BSP-0010", { firstName: "Erika" })),
        row(3, person("BSP-0011", twin)),
        row(4, person("BSP-0012", { firstName: "Max" })),
        row(5, person("BSP-0013", { firstName: "Max", birthDate: "1971-02-01" })),
        // Without a birth date nothing is compared.
        row(6, person("BSP-0014", { firstName: "Hans", birthDate: undefined })),
        row(7, person("BSP-0015", { firstName: "Hans", birthDate: undefined })),
      ],
      // Stored data padded too.
      [existing("p1", person("BSP-0001", { firstName: " max", lastName: "Mustermann  " }))],
      { relaxedRuleIds: relaxed },
    );
    expect(codes(result)).toEqual([
      ["create", "null:possible_duplicate"],
      ["create", "null:possible_duplicate"],
      ["create", "null:possible_duplicate"],
      ["create"],
      ["create"],
      ["create"],
    ]);
  });

  it("doesn't compare against rows that won't be created", () => {
    const result = plan(
      [
        row(2, person("BSP-0010", { firstName: "Erika" })),
        row(3, person("BSP-0011", { firstName: "Erika" }), [tooLong(3, "phone")]),
        row(4, person("BSP-0012", { firstName: "Erika", addressStreet: undefined })),
        row(5, person("BSP-0001", { firstName: "Erika" })),
      ],
      [existing("p1", person("BSP-0001"))],
    );
    expect(codes(result)[0]).toEqual(["create"]);
  });

  it("counts participations missing from the file and leaves them alone", () => {
    const result = plan(
      [row(2, person("BSP-0001"))],
      [existing("p1", person("BSP-0001")), existing("p2", person("BSP-0002"))],
    );
    expect(result.missing).toBe(1);
    expect(result.rows.map((r) => r.participationId)).toEqual(["p1"]);
  });
});

// Review of PR #44: row validation and the plan composed, as the import will call them.
describe("validateRow → planImport", () => {
  const cells: Partial<Record<ImportTarget, ImportCell | null>> = {
    personnelNumber: "BSP-0001",
    lastName: "Mustermann",
    firstName: "Erika",
    birthDate: "01.02.1970",
    oldEmploymentEndDate: "31.03.2027",
    addressStreet: "Musterstraße 1",
    addressPostalCode: "99999",
    addressCity: "Beispielstadt",
  };
  const validated = (n: number, change: Partial<Record<ImportTarget, ImportCell | null>>) =>
    validateRow({ row: n, cells: { ...cells, ...change }, country: "DE", today: "2026-10-19" });
  const stored = validated(2, {}).values;

  it("keeps stored required values for blank cells, and still blocks an incomplete new row", () => {
    const blanks = {
      lastName: "",
      birthDate: " ",
      addressStreet: null,
      addressPostalCode: null,
      addressCity: null,
    };
    const update = plan([validated(2, blanks)], [existing("p1", stored)]);
    expect(update.rows[0]!.outcome).toBe("unchanged");
    const create = plan(
      [validated(2, { ...blanks, personnelNumber: "BSP-0002" })],
      [existing("p1", stored)],
    );
    expect(codes(create)).toEqual([
      [
        "error",
        "lastName:required_missing",
        "birthDate:required_missing",
        "address:required_missing",
      ],
    ]);
  });

  it("updates a changed value and skips a terminal match despite an invalid cell", () => {
    const update = plan([validated(2, { addressCity: "Musterhausen" })], [existing("p1", stored)]);
    expect(update.rows[0]).toMatchObject({ outcome: "update", changed: ["addressCity"] });
    const terminal = plan(
      [validated(2, { birthDate: "31.02.1975" })],
      [existing("p1", stored, true)],
    );
    expect(codes(terminal)).toEqual([["skip", "null:terminal_not_updated"]]);
  });
});

describe("participant-maintained contact fields (Q112)", () => {
  const stored = {
    ...existing("p-1", person("BSP-0001", { phone: "030 1234567", mobile: "0171 3920000" })),
    participantMaintained: new Set(["address", "mobile"] as const),
  };

  it("never overwrites them and reports a differing value by target, never the value", () => {
    const result = plan(
      [
        row(
          2,
          person("BSP-0001", {
            addressStreet: "Neuer Weg 2",
            mobile: "0171 9999999",
            phone: "030 7654321",
          }),
        ),
      ],
      [stored],
    );
    expect(result.rows).toEqual([
      {
        row: 2,
        outcome: "update",
        participationId: "p-1",
        changed: ["phone"],
        issues: [
          { row: 2, target: "address", code: "participant_maintained", severity: "warning" },
          { row: 2, target: "mobile", code: "participant_maintained", severity: "warning" },
        ],
      },
    ]);
  });

  it("is unchanged when only maintained fields differ, and quiet when they match", () => {
    const differs = plan([row(2, person("BSP-0001", { mobile: "0171 1" }))], [stored]);
    expect(codes(differs)).toEqual([
      ["unchanged", "phone:kept_existing", "mobile:participant_maintained"],
    ]);
    const same = plan([row(2, person("BSP-0001", { mobile: "0171 3920000" }))], [stored]);
    expect(codes(same)).toEqual([["unchanged", "phone:kept_existing"]]);
  });

  it("keeps a maintained value for an empty cell without the kept notice", () => {
    const { addressStreet: _street, ...withoutAddress } = person("BSP-0001");
    const result = plan(
      [row(2, { ...withoutAddress, addressPostalCode: undefined, addressCity: undefined })],
      [stored],
    );
    expect(codes(result)).toEqual([["unchanged", "phone:kept_existing"]]);
  });
});

describe("writableValues", () => {
  it("drops the maintained targets, the address as a unit", () => {
    expect(
      writableValues(
        person("BSP-0001", { phone: "030 1", mobile: "0171 2" }),
        new Set(["address", "phone"]),
      ),
    ).toEqual({
      personnelNumber: "BSP-0001",
      lastName: "Mustermann",
      firstName: "Person BSP-0001",
      birthDate: "1970-02-01",
      oldEmploymentEndDate: "2027-03-31",
      mobile: "0171 2",
    });
    expect(writableValues({ phone: "030 1" })).toEqual({ phone: "030 1" });
  });
});
