import { describe, expect, it } from "vitest";
import { DsvScanMetadata, dsvScanProblems } from "./scans";

const input = {
  offerId: "00000000-0000-4000-8000-000000000001",
  receivedBy: "00000000-0000-4000-8000-000000000002",
  receivedOn: "2026-11-08",
  signatures: { participant: "2026-11-07" },
};

describe("DSV scan metadata", () => {
  it("requires an offer, receiver, receipt date and explicit signature record without defaults", () => {
    for (const key of Object.keys(input)) {
      const incomplete = { ...input } as Record<string, unknown>;
      delete incomplete[key];
      expect(DsvScanMetadata.safeParse(incomplete).success).toBe(false);
    }
    expect(DsvScanMetadata.parse(input)).toEqual(input);
    expect(DsvScanMetadata.parse({ ...input, signatures: {} }).signatures).toEqual({});
  });
  it("rejects impossible dates and unknown signature kinds", () => {
    expect(DsvScanMetadata.safeParse({ ...input, receivedOn: "2026-02-30" }).success).toBe(false);
    expect(
      DsvScanMetadata.safeParse({ ...input, signatures: { witness: "2026-11-07" } }).success,
    ).toBe(false);
  });
  it("allows today's dates and receipt on the participant's signature day", () => {
    expect(
      dsvScanProblems({ ...input, signatures: { participant: input.receivedOn } }, "2026-11-08"),
    ).toEqual([]);
    expect(dsvScanProblems({ ...input, signatures: {} }, "2026-11-08")).toEqual([]);
  });
  it("rejects each future signature and a future receipt", () => {
    for (const kind of ["participant", "customer", "transfergesellschaft"] as const) {
      expect(
        dsvScanProblems(
          { ...input, receivedOn: "2026-11-09", signatures: { [kind]: "2026-11-09" } },
          "2026-11-08",
        ),
      ).toEqual([
        { code: "received_in_future", field: "receivedOn" },
        { code: "signature_in_future", field: `signatures/${kind}` },
      ]);
    }
  });
  it("refuses receipt before the participant signature without constraining later countersignatures", () => {
    expect(dsvScanProblems({ ...input, receivedOn: "2026-11-06" }, "2026-11-08")).toEqual([
      { code: "received_before_signature", field: "receivedOn" },
    ]);
    expect(
      dsvScanProblems(
        { ...input, signatures: { customer: "2026-11-08" }, receivedOn: "2026-11-06" },
        "2026-11-08",
      ),
    ).toEqual([]);
  });
});

it("leaves an explicitly absent optional signature absent", () => {
  expect(
    dsvScanProblems(
      { receivedOn: "2026-11-08", signatures: { participant: undefined } },
      "2026-11-08",
    ),
  ).toEqual([]);
});
