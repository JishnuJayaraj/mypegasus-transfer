import { FormCode, FormVersion, isoDate } from "@transfer/domain";
import { z } from "zod";

// The forms manifest (ADR-0009): `templates/manifest.json`, written by `pnpm generate` from the
// version folders and drift-checked in CI like the Agentur template manifest.

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const FormsManifest = z.strictObject({
  /** Every official form version, by form code and version. */
  forms: z.array(
    z.strictObject({
      formCode: FormCode,
      version: FormVersion,
      /** As printed, e.g. `TL 407 08/2025`. */
      label: z.string().min(1),
      validFrom: isoDate.nullable(),
      validUntil: isoDate.nullable(),
      sha256,
      pages: z.int().positive(),
      fields: z.int().positive(),
    }),
  ),
  /** Our own HTML templates (`templates/own/<name>/v<n>/`), each file by its SHA-256. */
  templates: z.array(
    z.strictObject({
      ref: z.string().regex(/^[a-z0-9-]+:v[1-9][0-9]*$/),
      files: z.record(z.string(), sha256),
    }),
  ),
});
export type FormsManifest = z.infer<typeof FormsManifest>;

/** `source.json` as committed with each blank: provenance only (Q176), never edited. */
export const FormSource = z.object({
  formCode: FormCode,
  version: FormVersion,
  sourceUrl: z.url(),
  retrievedOn: isoDate,
  sha256,
  pages: z.int().positive(),
  acroFormFields: z.int().positive(),
  verifiedBlank: z.literal(true),
});
export type FormSource = z.infer<typeof FormSource>;
