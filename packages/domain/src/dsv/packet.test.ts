import { describe, expect, it } from "vitest";
import {
  dsvPacketFact,
  dsvSignatureDateProblem,
  dsvSignedOn,
  type DsvCountingScan,
} from "./packet";

// process-and-lifecycle.md, DSV packet: one reviewed complete packet gives `dsvFullyExecuted`;
// its validity is the latest actual date, its recording the scan's acceptance or later lift.
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

describe("dsvPacketFact", () => {
  it("is valid on the latest of the three actual dates and recorded at the scan", () => {
    expect(dsvPacketFact([scan("a", all)], "2026-03-02")).toEqual({
      documentId: "a",
      validOn: "2026-03-05",
      recordedAt: "2026-03-10T09:00:00.000Z",
    });
  });
  it("needs all three signatures on one scan; two scans never add up", () => {
    const first = scan("a", { participant: "2026-03-02", customer: "2026-03-05" });
    const second = scan("b", { transfergesellschaft: "2026-03-04" });
    expect(dsvPacketFact([first, second], "2026-03-02")).toBeNull();
  });
  it("ignores a packet whose participant date differs from the signed date", () => {
    expect(
      dsvPacketFact([scan("a", { ...all, participant: "2026-03-03" })], "2026-03-02"),
    ).toBeNull();
  });
  it("takes the earliest recorded counting packet", () => {
    const later = scan("b", all, "2026-03-12T09:00:00.000Z");
    const earlier = scan("a", all, "2026-03-11T09:00:00.000Z");
    expect(dsvPacketFact([later, earlier], "2026-03-02")?.documentId).toBe("a");
  });
  it("is null without a signed date or scans", () => {
    expect(dsvPacketFact([], "2026-03-02")).toBeNull();
    expect(dsvPacketFact([scan("a", all)], null)).toBeNull();
  });
});

describe("dsvSignedOn", () => {
  it("is the participant date of the accepted scans, null without one", () => {
    expect(dsvSignedOn([])).toBeNull();
    expect(dsvSignedOn(["2026-03-02", "2026-03-02"])).toBe("2026-03-02");
  });
});

describe("dsvSignatureDateProblem", () => {
  it("refuses a participant date that differs from an accepted scan of the offer", () => {
    expect(dsvSignatureDateProblem("2026-03-03", ["2026-03-02"])).toBe("signature_date_mismatch");
  });
  it("accepts an identical date, a first scan and a scan without the participant", () => {
    expect(dsvSignatureDateProblem("2026-03-02", ["2026-03-02"])).toBeNull();
    expect(dsvSignatureDateProblem("2026-03-02", [])).toBeNull();
    expect(dsvSignatureDateProblem(undefined, ["2026-03-02"])).toBeNull();
  });
});
