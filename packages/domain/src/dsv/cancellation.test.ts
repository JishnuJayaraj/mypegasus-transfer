import { describe, expect, it } from "vitest";
import {
  dsvCancellationFact,
  dsvCancellationReviewProblem,
  dsvCustomerNoticeDue,
  dsvCustomerNoticeProblem,
  type DsvCustomerNoticeState,
} from "./cancellation";
import type { DsvCountingScan } from "./packet";

// process-and-lifecycle.md, the cancellation of a signed DSV: one counting scan with the three
// parties' signatures; valid on the latest actual date, recorded when it counted.
const scan = (
  documentId: string,
  signatures: DsvCountingScan["signatures"],
  recordedAt = "2026-03-10T09:00:00.000Z",
): DsvCountingScan => ({ documentId, signatures, recordedAt });
const all = {
  participant: "2026-03-02",
  customer: "2026-03-05",
  transfergesellschaft: "2026-03-04",
};

describe("dsvCancellationReviewProblem", () => {
  it("accepts only all three signatures", () => {
    expect(dsvCancellationReviewProblem(all)).toBeNull();
    expect(
      dsvCancellationReviewProblem({ participant: "2026-03-02", customer: "2026-03-05" }),
    ).toBe("cancellation_signatures_missing");
    expect(dsvCancellationReviewProblem({})).toBe("cancellation_signatures_missing");
  });
});

describe("dsvCancellationFact", () => {
  it("is valid on the latest actual date and recorded at the scan", () => {
    expect(dsvCancellationFact([scan("a", all)])).toEqual({
      documentId: "a",
      validOn: "2026-03-05",
      recordedAt: "2026-03-10T09:00:00.000Z",
    });
  });
  it("needs the three signatures on one scan; two scans never add up", () => {
    const first = scan("a", { participant: "2026-03-02", customer: "2026-03-05" });
    const second = scan("b", { transfergesellschaft: "2026-03-04" });
    expect(dsvCancellationFact([first, second])).toBeNull();
    expect(dsvCancellationFact([])).toBeNull();
  });
  it("takes the earliest recorded counting cancellation (a lift moves only recordedAt)", () => {
    const late = scan("late", all, "2026-03-12T09:00:00.000Z");
    const early = scan("early", { ...all, customer: "2026-03-03" }, "2026-03-11T09:00:00.000Z");
    expect(dsvCancellationFact([late, early])).toEqual({
      documentId: "early",
      validOn: "2026-03-04",
      recordedAt: "2026-03-11T09:00:00.000Z",
    });
  });
});

const withdrawn: DsvCustomerNoticeState = {
  status: "withdrawn",
  dsvStatus: "dsv_signed",
  withdrawnOn: "2026-03-06",
  notifiedOn: null,
};

describe("dsvCustomerNoticeDue", () => {
  it("is due from the withdrawal of a signed DSV until recorded", () => {
    expect(dsvCustomerNoticeDue(withdrawn)).toBe("2026-03-06");
    expect(dsvCustomerNoticeDue({ ...withdrawn, notifiedOn: "2026-03-07" })).toBeNull();
  });
  it("is never due for another withdrawal or an open participation", () => {
    expect(dsvCustomerNoticeDue({ ...withdrawn, dsvStatus: "dsv_offered" })).toBeNull();
    expect(
      dsvCustomerNoticeDue({ ...withdrawn, status: "informed", withdrawnOn: null }),
    ).toBeNull();
    expect(dsvCustomerNoticeDue({ ...withdrawn, withdrawnOn: null })).toBeNull();
  });
});

describe("dsvCustomerNoticeProblem", () => {
  const today = "2026-03-09";
  it("takes a date from the withdrawal up to today", () => {
    expect(dsvCustomerNoticeProblem(withdrawn, "2026-03-06", today)).toBeNull();
    expect(dsvCustomerNoticeProblem(withdrawn, today, today)).toBeNull();
  });
  it("refuses a second notice, a notice not due, a future date and one before the withdrawal", () => {
    expect(
      dsvCustomerNoticeProblem({ ...withdrawn, notifiedOn: "2026-03-07" }, "2026-03-08", today),
    ).toBe("notice_recorded");
    expect(
      dsvCustomerNoticeProblem({ ...withdrawn, dsvStatus: "not_offered" }, "2026-03-08", today),
    ).toBe("notice_not_due");
    expect(dsvCustomerNoticeProblem(withdrawn, "2026-03-10", today)).toBe("date_in_future");
    expect(dsvCustomerNoticeProblem(withdrawn, "2026-03-05", today)).toBe(
      "notice_before_withdrawal",
    );
  });
});
