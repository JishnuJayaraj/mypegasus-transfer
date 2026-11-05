import type { DocumentType } from "../documents/catalog";
import type { IsoDate } from "../iso-date";

// "Nachweis ungültig" (`evidence_invalidated`; data-protection.md, evidence corrections; Q209 (7)
// as amended in the review of PR #103): an approved invalidation stays unresolved until
// replacement evidence actually supports the fact the invalidated evidence supported, with its
// linkage and effective date. The status that rested on it stays; no date is invented.

/** One approved invalidation of the participation. */
export type ApprovedInvalidation = {
  /** The approval's instant (ISO 8601 UTC) and its Berlin day. */
  decidedAt: string;
  decidedOn: IsoDate;
  target:
    | { kind: "asu_registration" }
    | {
        kind: "document";
        documentType: DocumentType;
        /** The catalog marks its type `signed`: evidence. */
        signed: boolean;
        /** It proved an ASU registration (the linked BA confirmation, a batch's scan). */
        supportedRegistration: boolean;
      };
};

/** What replacement evidence the participation has now. */
export type RecoveryFacts = {
  /** The fact `asuRegisteredWithProof` of the current registration, if it holds. */
  asu: { validOn: IsoDate; recordedAt: string } | null;
  /** The TG entry the ASU fact had to support; null before entry. */
  tgEntryDate: IsoDate | null;
  /** The retained completion of profiling the TL 407 had to support; null while open. */
  profilingDoneOn: IsoDate | null;
  /** The valid documents (accepted, live, not quarantined or invalidated). */
  documents: readonly { type: DocumentType; acceptedAt: string; signedOn: IsoDate | null }[];
  /** The current exception request is open on evidence that no longer counts. */
  exceptionUnsupported: boolean;
};

const later = (a: string, b: string) => Date.parse(a) > Date.parse(b);

/** The ASU fact holds again: recorded after the approval and valid by the TG entry. */
function asuRecovered(facts: RecoveryFacts, invalidation: ApprovedInvalidation, since: boolean) {
  const { asu, tgEntryDate } = facts;
  if (asu === null) return false;
  if (since && !later(asu.recordedAt, invalidation.decidedAt)) return false;
  return tgEntryDate === null || asu.validOn <= tgEntryDate;
}

/** Whether replacement evidence resolves one invalidation. */
export function invalidationResolved(
  invalidation: ApprovedInvalidation,
  facts: RecoveryFacts,
): boolean {
  const { target } = invalidation;
  if (target.kind === "asu_registration") return asuRecovered(facts, invalidation, true);
  if (!target.signed) return true;
  const { documentType } = target;
  if (target.supportedRegistration) return asuRecovered(facts, invalidation, true);
  // A BA confirmation proves nothing until a registration rests on it.
  if (documentType === "asu_proof") return asuRecovered(facts, invalidation, false);
  if (documentType === "profiling_exception_evidence") return !facts.exceptionUnsupported;
  return facts.documents.some(
    (document) =>
      document.type === documentType &&
      later(document.acceptedAt, invalidation.decidedAt) &&
      (documentType !== "tl407_signed_scan" ||
        facts.profilingDoneOn === null ||
        (document.signedOn !== null && document.signedOn <= facts.profilingDoneOn)),
  );
}

/** The Berlin day of the oldest unresolved invalidation, or null. */
export function evidenceInvalidatedSince(
  invalidations: readonly ApprovedInvalidation[],
  facts: RecoveryFacts,
): IsoDate | null {
  const open = invalidations
    .filter((invalidation) => !invalidationResolved(invalidation, facts))
    .map((invalidation) => invalidation.decidedOn)
    .toSorted();
  return open[0] ?? null;
}
