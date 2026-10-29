import { z } from "zod";
import { DocumentCapabilities } from "../documents/api";
import { ScanOrigin, Tl407Declarations } from "../documents/scans";
import { DocumentReviewReason, DocumentReviewState, QuarantineReason } from "../documents/state";
import { isoDate } from "../iso-date";
import { FormVersion } from "./field-map";
import { tl407WarningCodes } from "./tl407";
import { FormErrorCode } from "./validate";

// The TL 407's generation API (ADR-0010; data-protection.md, generated forms and the readiness
// projection): the readiness is built per viewer and an unauthorized property is absent from its
// schema, not hidden; generation takes the confirmations by code and answers with the document.

const instant = z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" });
const label = z.string().meta({ description: "As the form prints it, e.g. `7 Nachname`" });

export const Tl407ErrorCode = z
  .enum([...FormErrorCode, "form_version_unavailable"])
  .meta({ id: "Tl407ErrorCode" });
export type Tl407ErrorCode = z.infer<typeof Tl407ErrorCode>;

export const Tl407WarningCode = z.enum(tl407WarningCodes).meta({ id: "Tl407WarningCode" });
export type Tl407WarningCode = z.infer<typeof Tl407WarningCode>;

/**
 * What a check was made of (data-protection.md, generated forms): a SHA-256 over the form version,
 * the date, the source revisions, the identity, the contact details, the effective TG dates and
 * the organisation's fingerprint. A generation names it; a changed source refuses it before any
 * confirmation applies (`409 source_changed`).
 */
export const Tl407SourceToken = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .meta({ id: "Tl407SourceToken" });

const issue = <T extends z.ZodType>(code: T) =>
  z.strictObject({
    code,
    /** A field, a table, `table.column`, a group or `form`. */
    key: z.string(),
    /** The row of a table, from 0. */
    row: z.int().min(0).optional(),
    label,
  });

/**
 * The profiler's readiness: every error and warning code by key and the overflow onto the Anlage.
 * Its decryptions are each audited `sensitive_read`.
 */
export const Tl407ProfilerReadiness = z
  .strictObject({
    view: z.literal("profiler"),
    /** The version in use today, or null (`form_version_unavailable`). */
    formVersion: FormVersion.nullable(),
    /** No error: generation is possible once each warning is confirmed. */
    ready: z.boolean(),
    /** Sent back with the generation; its confirmations hold for these sources only. */
    sourceToken: Tl407SourceToken,
    errors: z.array(issue(Tl407ErrorCode)),
    warnings: z.array(issue(Tl407WarningCode)),
    overflow: z.array(z.strictObject({ kind: z.enum(["table", "text"]), key: z.string(), label })),
  })
  .meta({ id: "Tl407ProfilerReadiness" });

/**
 * The PL's readiness, from presence alone (no decryption): ready or not, and the missing `*`
 * fields the PL may know about. It has no warning and no overflow: both can derive from section C
 * or the sensitive answers.
 */
export const Tl407ReadinessSummary = z
  .strictObject({
    view: z.literal("project_lead"),
    /** Nothing the PL may know about is missing; the profiler's readiness decides generation. */
    ready: z.boolean(),
    missing: z.array(z.strictObject({ key: z.string(), label })),
  })
  .meta({ id: "Tl407ReadinessSummary" });

/** `GET …/forms/tl407/readiness`: the projection of the viewer (others 403). */
export const Tl407Readiness = z
  .discriminatedUnion("view", [Tl407ProfilerReadiness, Tl407ReadinessSummary])
  .meta({ id: "Tl407Readiness" });
export type Tl407Readiness = z.infer<typeof Tl407Readiness>;
export type Tl407ProfilerReadiness = z.infer<typeof Tl407ProfilerReadiness>;
export type Tl407ReadinessSummary = z.infer<typeof Tl407ReadinessSummary>;

/**
 * `POST …/forms/tl407` (the assigned consultant): the source token of the readiness the profiler
 * checked (`409 source_changed` when a source moved since, before any confirmation applies), and
 * each warning of the check confirmed by its code (each confirmation audited `warning_confirmed`);
 * a code the check doesn't raise is ignored.
 */
export const Tl407GenerationInput = z
  .strictObject({
    sourceToken: Tl407SourceToken,
    confirmWarnings: z
      .array(Tl407WarningCode)
      .max(tl407WarningCodes.length)
      .refine((codes) => new Set(codes).size === codes.length, {
        params: { code: "duplicate_value" },
      }),
  })
  .meta({ id: "Tl407GenerationInput" });
export type Tl407GenerationInput = z.infer<typeof Tl407GenerationInput>;

/** The generated form: the document (opened through the logged opening). */
export const Tl407Generation = z
  .strictObject({
    documentId: z.uuid(),
    formVersion: FormVersion,
    /** The "Anlage zum Profilingbogen" is appended to the packet. */
    anlage: z.boolean(),
  })
  .meta({ id: "Tl407Generation" });
export type Tl407Generation = z.infer<typeof Tl407Generation>;

/** A generated TL 407 as the tab lists it: metadata only (Q49). */
export const Tl407GeneratedForm = z
  .strictObject({
    documentId: z.uuid(),
    formVersion: FormVersion,
    generatedAt: instant,
    anlage: z.boolean(),
    /** The latest generation; an earlier one is superseded. */
    latest: z.boolean(),
    /** Its version is still in use today; else "Neu erzeugen" (ba-forms.md, versions). */
    versionInUse: z.boolean(),
    capabilities: z.strictObject({ open: z.boolean() }),
  })
  .meta({ id: "Tl407GeneratedForm" });
export type Tl407GeneratedForm = z.infer<typeof Tl407GeneratedForm>;

/**
 * A signed TL 407 scan as the tab lists it (data-protection.md, signed scans): metadata only, the
 * file through the logged opening; the generation it was printed from, its version (for external
 * paper once accepted), the actual signature dates, the review and a quarantine.
 */
export const Tl407ScanView = z
  .strictObject({
    documentId: z.uuid(),
    origin: ScanOrigin,
    generationDocumentId: z.uuid().nullable(),
    formVersion: FormVersion.nullable(),
    addedAt: instant,
    review: z.strictObject({
      state: DocumentReviewState,
      reasonCode: DocumentReviewReason.nullable(),
      reviewedAt: instant.nullable(),
    }),
    participantSignedOn: isoDate.nullable(),
    profilerSignedOn: isoDate.nullable(),
    quarantine: z.strictObject({ reasonCode: QuarantineReason, quarantinedAt: instant }).nullable(),
    capabilities: DocumentCapabilities,
  })
  .meta({ id: "Tl407Scan" });
export type Tl407ScanView = z.infer<typeof Tl407ScanView>;

/**
 * The declarations to the BA as signed (ba-forms.md, declarations to the BA): those of the latest
 * usable signed paper, with its scan, version, later signature date and acceptance; each paper's
 * own record is never rewritten.
 */
export const Tl407SignedDeclarations = Tl407Declarations.extend({
  documentId: z.uuid(),
  formVersion: FormVersion,
  signedOn: isoDate,
  acceptedAt: instant,
}).meta({ id: "Tl407SignedDeclarations" });

/**
 * The Kug 200b's handwriting and clarification checklist (Q197 (8)): the blank `*` fields and every
 * text that doesn't fit, by key and label, shown before printing; never a value.
 */
export const Kug200bChecklistItem = z
  .strictObject({ code: z.enum(["required_blank", "text_not_fitting"]), key: z.string(), label })
  .meta({ id: "Kug200bChecklistItem" });

/** A generated Kug 200b: the document (opened through the logged opening) and its checklist. */
export const Kug200bGeneration = z
  .strictObject({
    participationId: z.uuid(),
    documentId: z.uuid(),
    formVersion: FormVersion,
    checklist: z.array(Kug200bChecklistItem),
  })
  .meta({ id: "Kug200bGeneration" });
export type Kug200bGeneration = z.infer<typeof Kug200bGeneration>;

/** The most forms one bulk generation makes (data-protection.md, exports: a print file ≤ 100). */
export const kug200bBulkMax = 100;

/** `POST /projects/{projectId}/forms/kug200b` (the PL): 1–100 participations, each once. */
export const Kug200bBulkInput = z
  .strictObject({
    participationIds: z
      .array(z.uuid())
      .min(1)
      .max(kug200bBulkMax)
      .refine((ids) => new Set(ids).size === ids.length, { params: { code: "duplicate_value" } }),
  })
  .meta({ id: "Kug200bBulkInput" });
export type Kug200bBulkInput = z.infer<typeof Kug200bBulkInput>;

/** All generated or none: one per participation, in the order asked. */
export const Kug200bBulkGeneration = z
  .strictObject({ generations: z.array(Kug200bGeneration) })
  .meta({ id: "Kug200bBulkGeneration" });
export type Kug200bBulkGeneration = z.infer<typeof Kug200bBulkGeneration>;
