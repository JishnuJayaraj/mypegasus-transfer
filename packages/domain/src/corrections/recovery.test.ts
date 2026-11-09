import { describe, expect, it } from "vitest";
import {
  evidenceInvalidatedSince,
  invalidationResolved,
  type ApprovedInvalidation,
  type DsvSupport,
  type RecoveryFacts,
} from "./recovery";

// Q209 (7) as amended in the review of PR #103: "Nachweis ungültig" clears only when replacement
// evidence supports the fact, its linkage and its effective date.
const decided = { decidedAt: "2026-11-05T10:00:00.000Z", decidedOn: "2026-11-05" };
const before = "2026-11-05T09:00:00.000Z";
const after = "2026-11-05T11:00:00.000Z";
const none: RecoveryFacts = {
  asu: null,
  tgEntryDate: null,
  profilingDoneOn: null,
  documents: [],
  exceptionUnsupported: false,
};
const document = (
  documentType: Extract<ApprovedInvalidation["target"], { kind: "document" }>["documentType"],
  overrides: { signed?: boolean; supportedRegistration?: boolean } = {},
): ApprovedInvalidation => ({
  ...decided,
  target: {
    kind: "document",
    documentType,
    signed: true,
    supportedRegistration: false,
    ...overrides,
  },
});
const registration: ApprovedInvalidation = { ...decided, target: { kind: "asu_registration" } };

/** A participation whose profiling was completed on 20.10. with one valid TL 407. */
const tl407Scan = (signedOn: string | null, acceptedAt = after) => ({
  ...none,
  profilingDoneOn: "2026-10-20",
  documents: [{ type: "tl407_signed_scan" as const, acceptedAt, signedOn }],
});

describe("invalidationResolved", () => {
  it("needs, for an ASU registration, a current fact recorded after the approval and valid by the TG entry", () => {
    expect(invalidationResolved(registration, none)).toBe(false);
    // A new registration without proof gives no fact.
    const recovered = { ...none, asu: { validOn: "2026-11-01", recordedAt: after } };
    expect(invalidationResolved(registration, recovered)).toBe(true);
    expect(
      invalidationResolved(registration, {
        ...recovered,
        asu: { ...recovered.asu, recordedAt: before },
      }),
    ).toBe(false);
    expect(invalidationResolved(registration, { ...recovered, tgEntryDate: "2026-11-01" })).toBe(
      true,
    );
    expect(invalidationResolved(registration, { ...recovered, tgEntryDate: "2026-10-31" })).toBe(
      false,
    );
  });

  it("needs a linked proof for a BA confirmation: an accepted but unlinked replacement doesn't count", () => {
    const linked = document("asu_proof", { supportedRegistration: true });
    const unlinkedReplacement = {
      ...none,
      documents: [{ type: "asu_proof" as const, acceptedAt: after, signedOn: null }],
    };
    expect(invalidationResolved(linked, unlinkedReplacement)).toBe(false);
    expect(
      invalidationResolved(linked, { ...none, asu: { validOn: "2026-11-01", recordedAt: after } }),
    ).toBe(true);
    // One that proved nothing yet needs a registration resting on proof, whenever recorded.
    const unlinked = document("asu_proof");
    expect(invalidationResolved(unlinked, unlinkedReplacement)).toBe(false);
    expect(
      invalidationResolved(unlinked, {
        ...none,
        asu: { validOn: "2026-11-01", recordedAt: before },
      }),
    ).toBe(true);
  });

  it("needs a TL 407 accepted after the approval and signed by the retained profilingDoneOn", () => {
    const tl407 = document("tl407_signed_scan");
    expect(invalidationResolved(tl407, tl407Scan("2026-10-21"))).toBe(false);
    expect(invalidationResolved(tl407, tl407Scan(null))).toBe(false);
    expect(invalidationResolved(tl407, tl407Scan("2026-10-20", before))).toBe(false);
    expect(invalidationResolved(tl407, tl407Scan("2026-10-20"))).toBe(true);
    expect(invalidationResolved(tl407, { ...tl407Scan("2026-11-04"), profilingDoneOn: null })).toBe(
      true,
    );
  });

  it("follows the open exception request for its evidence, and a later valid document otherwise", () => {
    const evidence = document("profiling_exception_evidence");
    expect(invalidationResolved(evidence, { ...none, exceptionUnsupported: true })).toBe(false);
    expect(invalidationResolved(evidence, none)).toBe(true);
    const scan = document("kug200b_signed_scan");
    expect(invalidationResolved(scan, none)).toBe(false);
    expect(
      invalidationResolved(scan, {
        ...none,
        documents: [
          { type: "tl407_signed_scan", acceptedAt: after, signedOn: null },
          { type: "kug200b_signed_scan", acceptedAt: after, signedOn: null },
        ],
      }),
    ).toBe(true);
    // A batch's scan proved the registration: the fact must hold again.
    expect(
      invalidationResolved(document("kug200b_signed_scan", { supportedRegistration: true }), {
        ...none,
        documents: [{ type: "kug200b_signed_scan", acceptedAt: after, signedOn: null }],
      }),
    ).toBe(false);
    // A document that is no evidence raises nothing.
    expect(invalidationResolved(document("cv", { signed: false }), none)).toBe(true);
  });
});

describe("evidenceInvalidatedSince", () => {
  it("dates the warning by the oldest unresolved approval", () => {
    const older = {
      ...registration,
      decidedAt: "2026-11-01T10:00:00.000Z",
      decidedOn: "2026-11-01",
    };
    expect(evidenceInvalidatedSince([registration, older], none)).toBe("2026-11-01");
    expect(evidenceInvalidatedSince([document("cv", { signed: false })], none)).toBeNull();
    expect(evidenceInvalidatedSince([], none)).toBeNull();
  });
});

describe("a DSV scan's invalidation (D8)", () => {
  const dsv: DsvSupport = {
    offerId: "o1",
    signatures: { participant: "2026-03-02", customer: "2026-03-05" },
  };
  const invalidated: ApprovedInvalidation = {
    ...decided,
    target: {
      kind: "document",
      documentType: "dsv_signed_scan",
      signed: true,
      supportedRegistration: false,
      dsv,
    },
  };
  const replacement = (over: Partial<DsvSupport>, acceptedAt = after) => ({
    ...none,
    documents: [
      { type: "dsv_signed_scan" as const, acceptedAt, signedOn: null, dsv: { ...dsv, ...over } },
    ],
  });
  it("stays until a counting scan of the same offer after the approval shows the same dates", () => {
    expect(invalidationResolved(invalidated, none)).toBe(false);
    expect(invalidationResolved(invalidated, replacement({}, before))).toBe(false);
    expect(invalidationResolved(invalidated, replacement({}))).toBe(true);
  });
  it("is not resolved by another offer or a different date", () => {
    expect(invalidationResolved(invalidated, replacement({ offerId: "o2" }))).toBe(false);
    expect(
      invalidationResolved(
        invalidated,
        replacement({ signatures: { participant: "2026-03-03", customer: "2026-03-05" } }),
      ),
    ).toBe(false);
  });
  it("needs every signature the invalidated scan showed", () => {
    expect(
      invalidationResolved(invalidated, replacement({ signatures: { participant: "2026-03-02" } })),
    ).toBe(false);
    expect(
      invalidationResolved(
        invalidated,
        replacement({ signatures: { ...dsv.signatures, transfergesellschaft: "2026-03-06" } }),
      ),
    ).toBe(true);
  });
});
