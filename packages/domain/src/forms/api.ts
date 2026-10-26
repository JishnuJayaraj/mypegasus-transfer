import { z } from "zod";
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
 * `POST …/forms/tl407` (the assigned consultant): each warning of the check confirmed by its
 * code (each confirmation audited `warning_confirmed`); a code the check doesn't raise is ignored.
 */
export const Tl407GenerationInput = z
  .strictObject({
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
