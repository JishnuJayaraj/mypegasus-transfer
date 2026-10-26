import type { DocumentType } from "../documents/catalog";
import { fieldEntry } from "../fields/catalog";

/**
 * Who may request an evidence correction (`append_evidence_correction`; rounds 12–13, Q88
 * *assumed*). It covers only data retained in the evidence set; payroll and personnel data
 * are corrected by their own active/payroll operations while they are retained. An explicit
 * table: it is not derived from who may open a document, and it grants no read access. The
 * correction is an append-only record approved by the regional operations manager (four
 * eyes); it never changes a contract, lifecycle status, guard, payment or Transfer-KuG
 * eligibility on its own.
 */
export type EvidenceCorrectionTarget =
  | { kind: "document"; documentType: DocumentType; documentId: string }
  /** `entryId` names the one entry of a collection field (a profiling session). */
  | { kind: "field"; fieldKey: string; entryId?: string };

export type CorrectionRequester = "project_lead" | "back_office";

const pl: readonly CorrectionRequester[] = ["project_lead"];
const backOffice: readonly CorrectionRequester[] = ["back_office"];
const either: readonly CorrectionRequester[] = ["project_lead", "back_office"];

export const documentCorrectionAuthority: Readonly<
  Record<DocumentType, readonly CorrectionRequester[]>
> = {
  tl407_signed_scan: pl,
  kug200b_signed_scan: pl,
  dsv_signed_scan: either,
  dsv_cancellation: either,
  asu_proof: pl,
  profiling_exception_evidence: pl,
  cv: pl,
  participant_upload: pl,
  qualification_certificate: pl,
  // A working copy is no evidence: it isn't corrected, it expires (data-protection.md, generated
  // forms).
  tl407_form: [],
};

/** Evidence-set fields and their requesters (round 13); no other field is corrected this way. */
export const fieldCorrectionAuthority: Readonly<Record<string, readonly CorrectionRequester[]>> = {
  // PL: identity and case facts, measure participation, operational dates and times
  firstName: pl,
  lastName: pl,
  birthDate: pl,
  personnelNumber: pl,
  profilingSessions: pl,
  withdrawnOn: pl,
  profilingDoneOn: pl,
  // back office: the identifiers the BA evidence needs (not tax ID, IBAN or absences: payroll)
  pensionInsuranceNumber: backOffice,
  baCustomerNumber: backOffice,
  // DSV / TG employment dates are also operational participation dates: either may request
  dsvSignedOn: either,
  tgStart: either,
  tgEnd: either,
  tgEntryDate: either,
  exitDate: either,
};

/** Collection fields: a correction names one entry, never the whole collection (round 13). */
export const collectionFields: ReadonlySet<string> = new Set(["profilingSessions"]);

export const needsEntry = (target: EvidenceCorrectionTarget) =>
  target.kind === "field" && collectionFields.has(target.fieldKey) && !target.entryId;

export function correctionRequesters(
  target: EvidenceCorrectionTarget,
): readonly CorrectionRequester[] {
  if (target.kind === "document") return documentCorrectionAuthority[target.documentType];
  fieldEntry(target.fieldKey); // an unknown field is an error, not a denial
  return fieldCorrectionAuthority[target.fieldKey] ?? [];
}
