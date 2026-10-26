import { describe, expect, it } from "vitest";
import { workingCopyDays, workingCopyExpiry, type WorkingCopyFacts } from "./working-copy";

const at = (iso: string) => new Date(iso);
const generated: WorkingCopyFacts = {
  generatedAt: at("2091-03-01T10:00:00Z"),
  supersededAt: null,
  scanAcceptedAt: null,
  closedAt: null,
  legalHold: false,
};

describe("workingCopyExpiry (data-protection.md, generated forms; Q179)", () => {
  it("gives an abandoned sole form its 90 days, so none stays forever", () => {
    expect(workingCopyExpiry(generated)).toEqual({
      kind: "due",
      trigger: "abandoned",
      from: generated.generatedAt,
      afterDays: 90,
    });
  });

  it("takes the earliest deletion of supersession, an accepted scan and the terminal status", () => {
    const superseded = { ...generated, supersededAt: at("2091-03-10T10:00:00Z") };
    expect(workingCopyExpiry(superseded)).toMatchObject({ trigger: "superseded", afterDays: 30 });
    const accepted = { ...superseded, scanAcceptedAt: at("2091-03-05T10:00:00Z") };
    expect(workingCopyExpiry(accepted)).toMatchObject({ trigger: "scan_accepted" });
    const closed = { ...accepted, closedAt: at("2091-03-02T10:00:00Z") };
    expect(workingCopyExpiry(closed)).toMatchObject({ trigger: "participation_closed" });
    // Closed 61 days after generation: the abandonment's 90 days come first.
    const late = { ...generated, closedAt: at("2091-05-01T10:00:00Z") };
    expect(workingCopyExpiry(late)).toMatchObject({ trigger: "abandoned" });
  });

  it("is suspended by a legal hold", () => {
    expect(workingCopyExpiry({ ...generated, legalHold: true })).toEqual({ kind: "held" });
  });

  it("proposes the periods awaiting the DPO", () => {
    expect(workingCopyDays).toEqual({
      superseded: 30,
      scan_accepted: 30,
      abandoned: 90,
      participation_closed: 30,
    });
  });
});
