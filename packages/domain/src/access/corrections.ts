import type { DocumentType } from "../documents/catalog";
import { fieldEntry } from "../fields/catalog";

/**
 * Who may request an evidence correction (`append_evidence_correction`; round 12, Q88
 * *assumed*). An explicit table: it is not derived from who may open a document, and it grants
 * no read access. The correction is an append-only record approved by the regional operations
 * manager (four eyes); it never changes lifecycle guards, contractual dates, payments or
 * Transfer-KuG eligibility on its own.
 */
export type EvidenceCorrectionTarget =
  | { kind: "document"; documentType: DocumentType; documentId: string }
  | { kind: "field"; fieldKey: string };

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
  participant_upload: pl,
  qualification_certificate: pl,
};

/** Evidence-set fields and their requesters; every other field can't be corrected this way. */
export const fieldCorrectionAuthority: Readonly<Record<string, readonly CorrectionRequester[]>> = {
  // PL: identity and case facts, measure participation, operational dates and times
  firstName: pl,
  lastName: pl,
  birthDate: pl,
  address: pl,
  personnelNumber: pl,
  profilingSessions: pl,
  withdrawnOn: pl,
  profilingDoneOn: pl,
  // back office: payroll and BA identifiers, payroll dates
  pensionInsuranceNumber: backOffice,
  taxId: backOffice,
  iban: backOffice,
  baCustomerNumber: backOffice,
  absencePeriods: backOffice,
  // DSV / TG employment dates are also operational participation dates: either may request
  dsvSignedOn: either,
  tgStart: either,
  tgEnd: either,
  tgEntryDate: either,
  exitDate: either,
};

export function correctionRequesters(
  target: EvidenceCorrectionTarget,
): readonly CorrectionRequester[] {
  if (target.kind === "document") return documentCorrectionAuthority[target.documentType];
  fieldEntry(target.fieldKey); // an unknown field is an error, not a denial
  return fieldCorrectionAuthority[target.fieldKey] ?? [];
}
