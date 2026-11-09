import { describe, expect, it } from "vitest";
import { withdrawalProblem, withdrawRefusal } from "./withdrawal";

// process-and-lifecycle.md, the withdrawal after a signed DSV (Q46 verify, Q213).
const cancellation = { validOn: "2026-03-05", recordedAt: new Date("2026-03-06T09:00:00Z") };
const signed = {
  dsvStatus: "dsv_signed" as const,
  cancellation,
  effectiveDate: "2026-03-05",
  today: "2026-03-10",
  tgStart: "2026-03-10",
};

describe("withdrawalProblem", () => {
  it("allows a signed DSV's withdrawal on or before the planned start, dated from the cancellation", () => {
    expect(withdrawalProblem(signed)).toBeNull();
    expect(
      withdrawalProblem({ ...signed, effectiveDate: "2026-03-09", today: "2026-03-09" }),
    ).toBeNull();
  });
  it("refuses the day after the planned start: the entry clarification applies", () => {
    expect(withdrawalProblem({ ...signed, today: "2026-03-11" })).toBe("after_planned_start");
  });
  it("refuses an effective date before the cancellation's validity", () => {
    expect(withdrawalProblem({ ...signed, effectiveDate: "2026-03-04" })).toBe(
      "effective_date_before_cancellation",
    );
  });
  it("fails closed without a TG start", () => {
    expect(withdrawalProblem({ ...signed, tgStart: null })).toBe("tg_start_missing");
  });
  it("leaves the guard to name a missing cancellation", () => {
    expect(withdrawalProblem({ ...signed, cancellation: undefined })).toBeNull();
  });
  it("adds nothing to a withdrawal without a signed DSV", () => {
    expect(
      withdrawalProblem({
        ...signed,
        dsvStatus: "dsv_offered",
        today: "2026-04-01",
        tgStart: null,
      }),
    ).toBeNull();
  });
});

describe("withdrawRefusal", () => {
  const open = {
    permitted: true,
    projectActive: true,
    status: "informed" as const,
    dsvStatus: "dsv_signed" as const,
    cancellation,
    today: "2026-03-10",
    tgStart: "2026-03-10",
  };
  it("is open for the PL with a counting cancellation on or before the planned start", () => {
    expect(withdrawRefusal(open)).toBeNull();
    expect(
      withdrawRefusal({ ...open, dsvStatus: "not_offered", cancellation: undefined }),
    ).toBeNull();
  });
  it("names the first rule that closes it", () => {
    expect(withdrawRefusal({ ...open, permitted: false })).toBe("forbidden");
    expect(withdrawRefusal({ ...open, projectActive: false })).toBe("project_not_active");
    expect(withdrawRefusal({ ...open, status: "withdrawn" })).toBe("status_not_withdrawable");
    expect(withdrawRefusal({ ...open, cancellation: undefined })).toBe("dsv_cancellation_missing");
    expect(
      withdrawRefusal({ ...open, cancellation: { ...cancellation, validOn: "2026-03-11" } }),
    ).toBe("dsv_cancellation_missing");
    expect(withdrawRefusal({ ...open, today: "2026-03-11", cancellation })).toBe(
      "after_planned_start",
    );
    expect(withdrawRefusal({ ...open, tgStart: null })).toBe("tg_start_missing");
  });
});
