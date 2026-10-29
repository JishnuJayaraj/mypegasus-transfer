import { z } from "zod";
import { FormCode, FormVersion } from "../forms/field-map";
import { JobboerseChoice } from "../forms/input";
import { isoDate, type IsoDate } from "../iso-date";
import type { DocumentType } from "./catalog";

// Signed paper (data-protection.md, signed scans and signed declarations; ba-forms.md,
// declarations to the BA; Q183–Q185, Q191, Q193): a scan names its origin when it is added, and
// its acceptance records the actual signature dates, the reviewer's confirmations and the
// declarations as marked on the paper. Pure: the API checks this before the functions, which
// check the same again under the lock.

/**
 * Where a signed scan comes from: printed from a generated form of the same participation and form
 * (`generated`, so its version and the printed declarations are known), or a form completed
 * outside the app (`external_paper`, also before the platform), whose version the reviewer names.
 */
export const ScanOrigin = z.enum(["generated", "external_paper"]).meta({ id: "ScanOrigin" });
export type ScanOrigin = z.infer<typeof ScanOrigin>;

/** The signed types whose scan names an origin, and their form. */
export const scanForms: Readonly<Partial<Record<DocumentType, FormCode>>> = {
  tl407_signed_scan: "tl407",
  kug200b_signed_scan: "kug200b",
};
export const isScanType = (type: DocumentType) => scanForms[type] !== undefined;

/** What the reviewer confirms on the paper: both signatures, every page (the Anlage included). */
export const ScanConfirmation = z
  .enum(["signatures_present", "all_pages_present"])
  .meta({ id: "ScanConfirmation" });
export type ScanConfirmation = z.infer<typeof ScanConfirmation>;

/** The TL 407's declarations to the BA as marked; null where nothing is marked. */
export const Tl407Declarations = z
  .strictObject({
    jobboerseChoice: JobboerseChoice.nullable(),
    baContactConsent: z.boolean().nullable(),
  })
  .meta({ id: "Tl407Declarations" });
export type Tl407Declarations = z.infer<typeof Tl407Declarations>;

/**
 * An accepted scan's record (ba-forms.md, declarations to the BA): the participant's and the
 * profiler's actual signature dates, the confirmations, for external paper the registry version
 * printed on it (an expired one included), and the declarations: for a generated scan either
 * "as printed" (the generation's snapshot) or as marked; for external paper always as marked.
 */
export const ScanReview = z
  .strictObject({
    participantSignedOn: isoDate,
    profilerSignedOn: isoDate,
    confirmations: z
      .array(ScanConfirmation)
      .max(ScanConfirmation.options.length)
      .refine((codes) => new Set(codes).size === codes.length, {
        params: { code: "duplicate_value" },
      }),
    formVersion: FormVersion.optional(),
    declarations: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("as_printed") }),
      Tl407Declarations.extend({ kind: z.literal("as_marked") }),
    ]),
  })
  .meta({ id: "ScanReview" });
export type ScanReview = z.infer<typeof ScanReview>;

/** A refused scan upload or review: a code at a path below the body. */
export type ScanProblem = { code: string; field: string };

/** The upload names an origin exactly for the scan types, a generation exactly when `generated`. */
export function scanUploadProblems(
  type: DocumentType,
  input: { origin?: ScanOrigin | undefined; generationDocumentId?: string | undefined },
): ScanProblem[] {
  if (!isScanType(type)) {
    return [
      ...(input.origin === undefined ? [] : [{ code: "origin_not_allowed", field: "origin" }]),
      ...(input.generationDocumentId === undefined
        ? []
        : [{ code: "generation_not_allowed", field: "generationDocumentId" }]),
    ];
  }
  if (input.origin === undefined) return [{ code: "origin_required", field: "origin" }];
  const generated = input.origin === "generated";
  if (generated && input.generationDocumentId === undefined) {
    return [{ code: "generation_required", field: "generationDocumentId" }];
  }
  if (!generated && input.generationDocumentId !== undefined) {
    return [{ code: "generation_not_allowed", field: "generationDocumentId" }];
  }
  return [];
}

/** The later of the two actual signature dates: the day the signed TL 407 counts from (Q191). */
export function tl407SignedOn(dates: {
  participantSignedOn: IsoDate;
  profilerSignedOn: IsoDate;
}): IsoDate {
  const { participantSignedOn: a, profilerSignedOn: b } = dates;
  return a > b ? a : b;
}

/**
 * The checks of an acceptance (process-and-lifecycle.md, document review; Q184, Q191): both
 * signature dates not after today and, for a generated scan, not before its generation's Berlin
 * date; both confirmations; the version named exactly for external paper and known to the
 * registry (`versionKnown`, any validity); "as printed" only for a generated scan.
 */
export function scanReviewProblems(
  review: ScanReview,
  scan: { origin: ScanOrigin; generatedOn: IsoDate | null },
  today: IsoDate,
  versionKnown: (version: string) => boolean,
): ScanProblem[] {
  const problems: ScanProblem[] = [];
  for (const key of ["participantSignedOn", "profilerSignedOn"] as const) {
    const date = review[key];
    if (date > today) problems.push({ code: "signature_in_future", field: key });
    else if (scan.generatedOn !== null && date < scan.generatedOn) {
      problems.push({ code: "signature_before_generation", field: key });
    }
  }
  if (!ScanConfirmation.options.every((code) => review.confirmations.includes(code))) {
    problems.push({ code: "confirmation_required", field: "confirmations" });
  }
  const external = scan.origin === "external_paper";
  if (external && review.formVersion === undefined) {
    problems.push({ code: "form_version_required", field: "formVersion" });
  } else if (!external && review.formVersion !== undefined) {
    problems.push({ code: "form_version_not_allowed", field: "formVersion" });
  } else if (review.formVersion !== undefined && !versionKnown(review.formVersion)) {
    problems.push({ code: "form_version_unknown", field: "formVersion" });
  }
  if (external && review.declarations.kind === "as_printed") {
    problems.push({ code: "declarations_as_marked_required", field: "declarations" });
  }
  return problems;
}

/**
 * `profilingDoneOn` (Q191): by default the later actual signature date, never before it and never
 * in the future; the recording instant stays apart.
 */
export function profilingDoneOnProblem(
  date: IsoDate,
  signedOn: IsoDate,
  today: IsoDate,
): "effective_date_before_signature" | "effective_date_in_future" | null {
  if (date > today) return "effective_date_in_future";
  return date < signedOn ? "effective_date_before_signature" : null;
}

/**
 * What the reviewer confirms on a signed Kug 200b, on the actual paper (Q185): declarations 16 and
 * 17 ticked by the participant, the mandatory information completed (also what was left blank for
 * handwriting) and the handwritten signature. No preselection: each is the reviewer's own check.
 */
export const Kug200bScanConfirmation = z
  .enum(["declarations_ticked", "mandatory_completed", "signature_present"])
  .meta({ id: "Kug200bScanConfirmation" });
export type Kug200bScanConfirmation = z.infer<typeof Kug200bScanConfirmation>;

/**
 * The Kug 200b's declarations as signed (ba-forms.md, declarations to the BA): 16, the written
 * registration as job-seeking, and 17, the acknowledgement of the TG's selective access to the BA
 * applicant profile, recorded as written (Q185). An acceptance needs both ticked, so both are
 * recorded `yes`.
 */
export const kug200bDeclarations = ["kug200bJobSeeking", "kug200bProfileAccess"] as const;

/**
 * An accepted Kug 200b scan's record: the date written in field 19 (the participant's signature
 * date), the three confirmations and, for external paper, the registry version printed on it.
 */
export const Kug200bScanReview = z
  .strictObject({
    signedOn: isoDate,
    confirmations: z
      .array(Kug200bScanConfirmation)
      .max(Kug200bScanConfirmation.options.length)
      .refine((codes) => new Set(codes).size === codes.length, {
        params: { code: "duplicate_value" },
      }),
    formVersion: FormVersion.optional(),
  })
  .meta({ id: "Kug200bScanReview" });
export type Kug200bScanReview = z.infer<typeof Kug200bScanReview>;

/**
 * The checks of a Kug 200b acceptance (Q184, Q185): the date not after today and, for a generated
 * scan, not before its generation's Berlin date; all three confirmations; the version named
 * exactly for external paper and known to the registry (any validity).
 */
export function kug200bScanReviewProblems(
  review: Kug200bScanReview,
  scan: { origin: ScanOrigin; generatedOn: IsoDate | null },
  today: IsoDate,
  versionKnown: (version: string) => boolean,
): ScanProblem[] {
  const problems: ScanProblem[] = [];
  if (review.signedOn > today) problems.push({ code: "signature_in_future", field: "signedOn" });
  else if (scan.generatedOn !== null && review.signedOn < scan.generatedOn) {
    problems.push({ code: "signature_before_generation", field: "signedOn" });
  }
  if (!Kug200bScanConfirmation.options.every((code) => review.confirmations.includes(code))) {
    problems.push({ code: "confirmation_required", field: "confirmations" });
  }
  const external = scan.origin === "external_paper";
  if (external && review.formVersion === undefined) {
    problems.push({ code: "form_version_required", field: "formVersion" });
  } else if (!external && review.formVersion !== undefined) {
    problems.push({ code: "form_version_not_allowed", field: "formVersion" });
  } else if (review.formVersion !== undefined && !versionKnown(review.formVersion)) {
    problems.push({ code: "form_version_unknown", field: "formVersion" });
  }
  return problems;
}
