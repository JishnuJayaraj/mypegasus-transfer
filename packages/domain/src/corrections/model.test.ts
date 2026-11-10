import { describe, expect, it } from "vitest";
import { accessProfiles, sample } from "../access/profiles";
import {
  correctionRequestable,
  correctionShape,
  CorrectionReason,
  EvidenceCorrectionRequestInput,
  fieldCorrectionProblem,
  signatureCorrectionProblem,
  mayDecideCorrection,
  mayRequestCorrection,
  normaliseCorrectionSource,
} from "./model";

const subject = (key: string) => accessProfiles.find((p) => p.key === key)!.subject;
const target = {
  projectId: sample.projectId,
  regionId: sample.regionId,
  participationId: sample.participationId,
};
const id = "00000000-0000-4000-a000-000000000009";

describe("evidence corrections (data-protection.md, evidence corrections; Q209)", () => {
  it("names the four documented reasons", () => {
    expect(CorrectionReason.options).toEqual([
      "ba_legal_reference",
      "data_subject_rectification",
      "corrected_source_document",
      "documented_internal_error",
    ]);
  });

  it("normalises the documented source and refuses control characters or nothing", () => {
    expect(normaliseCorrectionSource("  Schreibené  vom   3.11. ")).toBe("Schreibené vom 3.11.");
    expect(normaliseCorrectionSource("a\tb")).toBe("a b");
    expect(normaliseCorrectionSource("a\nb")).toBeNull();
    expect(normaliseCorrectionSource("   ")).toBeNull();
  });

  it("takes each value explicitly: no default reason, source, choice or date", () => {
    const valid = {
      correction: "invalidate_document",
      documentId: id,
      wrongPerson: true,
      reason: "documented_internal_error",
      source: "Vermerk PL 03.11.",
    };
    expect(EvidenceCorrectionRequestInput.safeParse(valid).success).toBe(true);
    for (const key of ["wrongPerson", "reason", "source"]) {
      const { [key]: _, ...without } = valid as Record<string, unknown>;
      expect(EvidenceCorrectionRequestInput.safeParse(without).success).toBe(false);
    }
    expect(
      EvidenceCorrectionRequestInput.safeParse({ ...valid, source: "x".repeat(201) }).success,
    ).toBe(false);
    expect(
      EvidenceCorrectionRequestInput.safeParse({
        correction: "supersede_asu_registration",
        registrationId: id,
        reason: "ba_legal_reference",
        source: "BA-Bescheid",
      }).success,
    ).toBe(false);
  });

  it("maps each request to its target kind and action", () => {
    expect(
      (
        [
          "invalidate_document",
          "invalidate_asu_registration",
          "supersede_asu_registration",
          "supersede_ba_report",
          "correct_field",
          "supersede_dsv_signature",
        ] as const
      ).map(correctionShape),
    ).toEqual([
      { targetKind: "document", action: "invalidate" },
      { targetKind: "asu_registration", action: "invalidate" },
      { targetKind: "asu_registration", action: "supersede" },
      { targetKind: "ba_reporting_task", action: "supersede" },
      { targetKind: "field", action: "supersede" },
      { targetKind: "dsv_signature", action: "supersede" },
    ]);
  });

  it("accepts a field correction of the two date fields only, and a signature supersession", () => {
    const base = { reason: "documented_internal_error", source: "Akte S. 3" };
    for (const field of ["profilingDoneOn", "withdrawnOn"]) {
      expect(
        EvidenceCorrectionRequestInput.safeParse({
          correction: "correct_field",
          field,
          value: "2026-03-14",
          ...base,
        }).success,
      ).toBe(true);
    }
    for (const field of ["dsvSignedOn", "tgStart", "firstName"]) {
      expect(
        EvidenceCorrectionRequestInput.safeParse({
          correction: "correct_field",
          field,
          value: "2026-03-14",
          ...base,
        }).success,
      ).toBe(false);
    }
    const signature = {
      correction: "supersede_dsv_signature",
      offerId: id,
      paper: "dsv_signed_scan",
      signature: "participant",
      signedOn: "2026-03-14",
      ...base,
    };
    expect(EvidenceCorrectionRequestInput.safeParse(signature).success).toBe(true);
    expect(
      EvidenceCorrectionRequestInput.safeParse({ ...signature, paper: "dsv_form" }).success,
    ).toBe(false);
    expect(
      EvidenceCorrectionRequestInput.safeParse({ ...signature, signedOn: "2026-02-30" }).success,
    ).toBe(false);
  });

  it("lets the PL request (by the authority table) and the regional operations manager decide, never their own", () => {
    const pl = subject("project_lead");
    const rom = subject("regional_operations_manager");
    for (const t of [
      { kind: "asu_registration", registrationId: id },
      { kind: "ba_reporting_task", taskId: id },
      { kind: "document", documentType: "tl407_signed_scan", documentId: id },
    ] as const) {
      expect(mayRequestCorrection(pl, t, target)).toBe(true);
      expect(mayRequestCorrection(subject("consultant"), t, target)).toBe(false);
      expect(mayRequestCorrection(rom, t, target)).toBe(false);
    }
    expect(
      mayRequestCorrection(
        subject("back_office"),
        { kind: "ba_reporting_task", taskId: id },
        target,
      ),
    ).toBe(false);
    expect(mayDecideCorrection(rom, "someone-else", target)).toBe(true);
    expect(mayDecideCorrection(pl, "someone-else", target)).toBe(false);
    if (rom.kind !== "staff") throw new Error("staff");
    expect(mayDecideCorrection(rom, rom.staffUserId, target)).toBe(false);
  });

  it("admits a request only on a target's correctable state, one at a time", () => {
    const accepted = { kind: "document", reviewState: "accepted", invalidated: false } as const;
    expect(correctionRequestable(accepted, false)).toBe(true);
    expect(correctionRequestable(accepted, true)).toBe(false);
    expect(correctionRequestable({ ...accepted, reviewState: "unreviewed" }, false)).toBe(false);
    expect(correctionRequestable({ ...accepted, invalidated: true }, false)).toBe(false);
    expect(correctionRequestable({ kind: "asu_registration", current: true }, false)).toBe(true);
    expect(correctionRequestable({ kind: "asu_registration", current: false }, false)).toBe(false);
    const closed = { kind: "ba_reporting_task", status: "reported", superseded: false } as const;
    expect(correctionRequestable(closed, false)).toBe(true);
    expect(correctionRequestable({ ...closed, status: "pending" }, false)).toBe(false);
    expect(correctionRequestable({ ...closed, superseded: true }, false)).toBe(false);
  });
});

describe("date correction rules (data-protection.md, evidence corrections: field targets)", () => {
  const today = "2026-04-01";
  const profiling = {
    field: "profilingDoneOn",
    current: "2026-03-20",
    tl407SignedOn: "2026-03-10",
  } as const;
  const withdrawal = {
    field: "withdrawnOn",
    current: "2026-03-20",
    withdrawnBy: "user",
    signedDsv: false,
    cancellationValidOn: null,
  } as const;

  it("checks profilingDoneOn at its boundaries", () => {
    expect(fieldCorrectionProblem({ ...profiling, current: null }, "2026-03-12", today)).toEqual({
      code: "field_not_recorded",
      field: "field",
    });
    expect(fieldCorrectionProblem(profiling, "2026-03-20", today)?.code).toBe(
      "correction_unchanged",
    );
    expect(fieldCorrectionProblem(profiling, "2026-04-02", today)?.code).toBe(
      "corrected_on_in_future",
    );
    expect(fieldCorrectionProblem(profiling, today, today)).toBeNull();
    expect(fieldCorrectionProblem(profiling, "2026-03-09", today)?.code).toBe(
      "effective_date_before_signature",
    );
    expect(fieldCorrectionProblem(profiling, "2026-03-10", today)).toBeNull();
    expect(
      fieldCorrectionProblem({ ...profiling, tl407SignedOn: null }, "2026-03-12", today)?.code,
    ).toBe("effective_date_before_signature");
  });

  it("checks withdrawnOn: manual only, and not before the cancellation of a signed DSV", () => {
    expect(fieldCorrectionProblem({ ...withdrawal, current: null }, "2026-03-12", today)?.code).toBe(
      "field_not_recorded",
    );
    expect(
      fieldCorrectionProblem({ ...withdrawal, withdrawnBy: "system" }, "2026-03-12", today)?.code,
    ).toBe("withdrawal_by_system");
    expect(fieldCorrectionProblem(withdrawal, "2026-03-01", today)).toBeNull();
    expect(fieldCorrectionProblem(withdrawal, "2026-04-02", today)?.code).toBe(
      "corrected_on_in_future",
    );
    const signed = { ...withdrawal, signedDsv: true, cancellationValidOn: "2026-03-15" } as const;
    expect(fieldCorrectionProblem(signed, "2026-03-14", today)?.code).toBe(
      "effective_date_before_cancellation",
    );
    expect(fieldCorrectionProblem(signed, "2026-03-15", today)).toBeNull();
    expect(
      fieldCorrectionProblem({ ...signed, cancellationValidOn: null }, "2026-03-15", today)?.code,
    ).toBe("effective_date_before_cancellation");
  });

  it("checks a signature supersession: shown, one date, unchanged, future, the paper's order", () => {
    const scans = [
      { signedOn: "2026-04-14", receivedOn: "2026-03-15" },
      { signedOn: "2026-04-14", receivedOn: "2026-03-20" },
    ];
    const later = "2026-05-01";
    expect(signatureCorrectionProblem([], "participant", "2026-03-14", later)?.code).toBe(
      "signature_not_shown",
    );
    expect(
      signatureCorrectionProblem(
        [scans[0]!, { ...scans[1]!, signedOn: "2026-04-15" }],
        "participant",
        "2026-03-14",
        later,
      )?.code,
    ).toBe("signature_date_mismatch");
    expect(signatureCorrectionProblem(scans, "participant", "2026-04-14", later)?.code).toBe(
      "correction_unchanged",
    );
    expect(signatureCorrectionProblem(scans, "participant", "2026-05-02", later)?.code).toBe(
      "corrected_on_in_future",
    );
    expect(signatureCorrectionProblem(scans, "participant", "2026-03-16", later)).toEqual({
      code: "received_before_signature",
      field: "signedOn",
    });
    expect(signatureCorrectionProblem(scans, "participant", "2026-03-15", later)).toBeNull();
    // Only the participant's date is bound by the receipt.
    expect(signatureCorrectionProblem(scans, "customer", "2026-03-16", later)).toBeNull();
  });
});
