import { describe, expect, it } from "vitest";
import {
  isScanType,
  profilingDoneOnProblem,
  ScanReview,
  scanReviewProblems,
  scanUploadProblems,
  tl407SignedOn,
} from "./scans";

// Signed paper (data-protection.md, signed scans; ba-forms.md, declarations to the BA; Q184,
// Q191, Q193).
const today = "2026-10-27";
const known = (version: string) => ["08-2025", "03-2019"].includes(version);
const review = (overrides: Partial<ScanReview> = {}): ScanReview => ({
  participantSignedOn: "2026-10-20",
  profilerSignedOn: "2026-10-21",
  confirmations: ["signatures_present", "all_pages_present"],
  declarations: { kind: "as_printed" },
  ...overrides,
});
const generated = { origin: "generated", generatedOn: "2026-10-20" } as const;
const external = { origin: "external_paper", generatedOn: null } as const;
const codes = (problems: { code: string; field: string }[]) =>
  problems.map(({ code, field }) => `${field}:${code}`);

describe("scanUploadProblems", () => {
  it("needs an origin for a scan, and the generation exactly when it is generated", () => {
    expect(isScanType("tl407_signed_scan")).toBe(true);
    expect(isScanType("cv")).toBe(false);
    const scan = "tl407_signed_scan";
    expect(codes(scanUploadProblems(scan, {}))).toEqual(["origin:origin_required"]);
    expect(codes(scanUploadProblems(scan, { origin: "generated" }))).toEqual([
      "generationDocumentId:generation_required",
    ]);
    expect(scanUploadProblems(scan, { origin: "generated", generationDocumentId: "g" })).toEqual(
      [],
    );
    expect(scanUploadProblems(scan, { origin: "external_paper" })).toEqual([]);
    expect(
      codes(scanUploadProblems(scan, { origin: "external_paper", generationDocumentId: "g" })),
    ).toEqual(["generationDocumentId:generation_not_allowed"]);
  });

  it("takes neither for any other type", () => {
    expect(scanUploadProblems("cv", {})).toEqual([]);
    expect(
      codes(scanUploadProblems("cv", { origin: "generated", generationDocumentId: "g" })),
    ).toEqual(["origin:origin_not_allowed", "generationDocumentId:generation_not_allowed"]);
  });
});

describe("scanReviewProblems", () => {
  it("accepts a generated scan as printed, signed on or after the generation", () => {
    expect(scanReviewProblems(review(), generated, today, known)).toEqual([]);
    expect(
      scanReviewProblems(
        review({ participantSignedOn: today, profilerSignedOn: today }),
        generated,
        today,
        known,
      ),
    ).toEqual([]);
  });

  it("refuses a signature date in the future, or before the generation", () => {
    expect(
      codes(
        scanReviewProblems(
          review({ participantSignedOn: "2026-10-28", profilerSignedOn: "2026-10-19" }),
          generated,
          today,
          known,
        ),
      ),
    ).toEqual([
      "participantSignedOn:signature_in_future",
      "profilerSignedOn:signature_before_generation",
    ]);
  });

  it("needs both confirmations", () => {
    expect(
      codes(
        scanReviewProblems(
          review({ confirmations: ["signatures_present"] }),
          generated,
          today,
          known,
        ),
      ),
    ).toEqual(["confirmations:confirmation_required"]);
  });

  it("takes external paper signed before the platform with a registry version, expired too", () => {
    const old = review({
      participantSignedOn: "2019-05-02",
      profilerSignedOn: "2019-05-02",
      formVersion: "03-2019",
      declarations: { kind: "as_marked", jobboerseChoice: "none", baContactConsent: null },
    });
    expect(scanReviewProblems(old, external, today, known)).toEqual([]);
    expect(
      codes(scanReviewProblems({ ...old, formVersion: "01-2001" }, external, today, known)),
    ).toEqual(["formVersion:form_version_unknown"]);
    const { formVersion: _, ...unnamed } = old;
    expect(codes(scanReviewProblems(unnamed, external, today, known))).toEqual([
      "formVersion:form_version_required",
    ]);
  });

  it("records external paper as marked, never as printed; a generated scan names no version", () => {
    expect(
      codes(scanReviewProblems(review({ formVersion: "08-2025" }), external, today, known)),
    ).toEqual(["declarations:declarations_as_marked_required"]);
    expect(
      codes(scanReviewProblems(review({ formVersion: "08-2025" }), generated, today, known)),
    ).toEqual(["formVersion:form_version_not_allowed"]);
  });
});

describe("tl407SignedOn and profilingDoneOn (Q191)", () => {
  it("is the later signature date, the default and the earliest profilingDoneOn", () => {
    const signedOn = tl407SignedOn({
      participantSignedOn: "2026-10-21",
      profilerSignedOn: "2026-10-20",
    });
    expect(signedOn).toBe("2026-10-21");
    expect(tl407SignedOn({ participantSignedOn: "2026-10-01", profilerSignedOn: signedOn })).toBe(
      signedOn,
    );
    expect(profilingDoneOnProblem(signedOn, signedOn, today)).toBeNull();
    expect(profilingDoneOnProblem(today, signedOn, today)).toBeNull();
    expect(profilingDoneOnProblem("2026-10-20", signedOn, today)).toBe(
      "effective_date_before_signature",
    );
    expect(profilingDoneOnProblem("2026-10-28", signedOn, today)).toBe("effective_date_in_future");
  });
});
