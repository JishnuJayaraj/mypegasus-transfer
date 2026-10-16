import { describe, expect, it } from "vitest";
import type { IsoDate } from "../iso-date";
import { transferKugEligibility, type KugEligibilityInput } from "./transfer-kug";

// Entered on 2027-04-01 under an exception approved on 2027-03-20: profiling is due by
// 2027-05-01 (one month, Q74).
const base: KugEligibilityInput = {
  tgEntryDate: "2027-04-01",
  exitDate: null,
  profilingDoneOn: null,
  profilingDeclinedOn: null,
  exceptionApprovedOn: "2027-03-20",
};
const kug = (input: Partial<KugEligibilityInput>, today: IsoDate = "2027-04-15") =>
  transferKugEligibility({ ...base, ...input }, today);
const period = (from: IsoDate, to: IsoDate | null, outcome: string) => ({ from, to, outcome });

describe("Transfer-KuG eligibility (AC-12, verify Q74/Q82)", () => {
  it("not entered: no employment, no periods", () => {
    expect(kug({ tgEntryDate: null })).toEqual({ employment: null, periods: [] });
  });

  it("profiling done on or before entry: eligible from entry", () => {
    for (const profilingDoneOn of ["2027-03-10", "2027-04-01"]) {
      expect(kug({ profilingDoneOn, exceptionApprovedOn: null })).toEqual({
        employment: { from: "2027-04-01", to: null },
        periods: [period("2027-04-01", null, "eligible")],
      });
    }
  });

  it("completed within the month: excluded through completion, eligible from the next day", () => {
    expect(kug({ profilingDoneOn: "2027-04-20" }, "2027-06-01").periods).toEqual([
      period("2027-04-01", "2027-04-20", "excluded"),
      period("2027-04-21", null, "eligible"),
    ]);
  });

  it("completed on the deadline day itself still counts; the day after is a miss", () => {
    expect(kug({ profilingDoneOn: "2027-05-01" }, "2027-06-01").periods).toEqual([
      period("2027-04-01", "2027-05-01", "excluded"),
      period("2027-05-02", null, "eligible"),
    ]);
    expect(kug({ profilingDoneOn: "2027-05-02" }, "2027-06-01").periods).toEqual([
      period("2027-04-01", null, "ba_review_required"),
    ]);
  });

  it("not yet completed: excluded while the deadline runs, then ba_review_required", () => {
    expect(kug({}, "2027-05-01").periods).toEqual([period("2027-04-01", null, "excluded")]);
    expect(kug({}, "2027-05-02").periods).toEqual([
      period("2027-04-01", null, "ba_review_required"),
    ]);
  });

  it("a refusal before completion is excluded from entry, not from the refusal", () => {
    expect(kug({ profilingDeclinedOn: "2027-04-10" }, "2027-09-01").periods).toEqual([
      period("2027-04-01", null, "excluded"),
    ]);
    // A refusal after the deadline was missed doesn't clear the miss.
    expect(kug({ profilingDeclinedOn: "2027-05-10" }, "2027-09-01").periods).toEqual([
      period("2027-04-01", null, "ba_review_required"),
    ]);
  });

  it.each([
    ["2027-01-31", "2027-02-28", "2027-03-01"],
    ["2028-01-31", "2028-02-29", "2028-03-01"],
    ["2027-03-31", "2027-04-30", "2027-05-01"],
  ] as const)("month end: entry %s is due by %s", (tgEntryDate, due, late) => {
    const input = { tgEntryDate, exceptionApprovedOn: tgEntryDate };
    expect(kug({ ...input, profilingDoneOn: due }, "2028-06-01").periods[1]?.outcome).toBe(
      "eligible",
    );
    expect(kug({ ...input, profilingDoneOn: late }, "2028-06-01").periods).toEqual([
      period(tgEntryDate, null, "ba_review_required"),
    ]);
  });

  it("entry without profiling or an approval by the entry date needs BA review (D10)", () => {
    expect(kug({ exceptionApprovedOn: null, profilingDoneOn: "2027-04-02" }).periods).toEqual([
      period("2027-04-01", null, "ba_review_required"),
    ]);
    expect(kug({ exceptionApprovedOn: "2027-04-02" }).periods).toEqual([
      period("2027-04-01", null, "ba_review_required"),
    ]);
  });

  it("the exit closes the employment and the periods, independently of the outcome", () => {
    expect(kug({ profilingDoneOn: "2027-04-20", exitDate: "2027-12-31" }, "2028-01-10")).toEqual({
      employment: { from: "2027-04-01", to: "2027-12-31" },
      periods: [
        period("2027-04-01", "2027-04-20", "excluded"),
        period("2027-04-21", "2027-12-31", "eligible"),
      ],
    });
    // Completed after an early exit: no eligible period remains.
    expect(kug({ profilingDoneOn: "2027-04-20", exitDate: "2027-04-10" }, "2027-05-01")).toEqual({
      employment: { from: "2027-04-01", to: "2027-04-10" },
      periods: [period("2027-04-01", "2027-04-10", "excluded")],
    });
  });
});

const determination = (from: IsoDate, to: IsoDate | null, outcome: "eligible" | "excluded") => ({
  from,
  to,
  outcome,
  reference: "determination-1",
});

describe("recorded BA/legal determinations (Q82)", () => {
  const missed = { profilingDoneOn: "2027-05-20" };
  const today = "2027-09-01";

  it("alter a period that needs BA review, and only there", () => {
    const { periods } = transferKugEligibility({ ...base, ...missed }, today, [
      determination("2027-04-01", "2027-05-20", "excluded"),
      determination("2027-05-21", null, "eligible"),
    ]);
    expect(periods).toEqual([
      { ...period("2027-04-01", "2027-05-20", "excluded"), determination: "determination-1" },
      { ...period("2027-05-21", null, "eligible"), determination: "determination-1" },
    ]);
  });

  it("leave the rest of the period under review", () => {
    const { periods } = transferKugEligibility({ ...base, ...missed }, today, [
      determination("2027-05-01", "2027-06-30", "excluded"),
    ]);
    expect(periods).toEqual([
      period("2027-04-01", "2027-04-30", "ba_review_required"),
      { ...period("2027-05-01", "2027-06-30", "excluded"), determination: "determination-1" },
      period("2027-07-01", null, "ba_review_required"),
    ]);
  });

  it("don't change a computed outcome that needs no review", () => {
    const input = { ...base, profilingDoneOn: "2027-04-20" };
    expect(
      transferKugEligibility(input, today, [determination("2027-04-01", null, "eligible")]),
    ).toEqual(transferKugEligibility(input, today));
  });

  it("outside the period under review, change nothing", () => {
    const input = { ...base, ...missed, exitDate: "2027-04-30" };
    const before = determination("2027-01-01", "2027-03-31", "eligible");
    const after = determination("2027-05-01", null, "eligible");
    expect(transferKugEligibility(input, today, [before, after]).periods).toEqual([
      period("2027-04-01", "2027-04-30", "ba_review_required"),
    ]);
  });

  it("may not overlap", () => {
    expect(() =>
      transferKugEligibility({ ...base, ...missed }, today, [
        determination("2027-04-01", "2027-05-31", "excluded"),
        determination("2027-05-31", null, "eligible"),
      ]),
    ).toThrow("Overlapping determinations");
  });
});
