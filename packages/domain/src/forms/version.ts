import { z } from "zod";
import { compareIsoDates } from "../dates";
import { isoDate, type IsoDate } from "../iso-date";
import { FormCode, FormVersion } from "./field-map";

// The form registry's versions (ADR-0009; Q188): `templates/ba/<formCode>/<version>/manifest.json`.
// The effective dates come from a reviewed source or are null, never from the printed version
// month; the PDF's SHA-256 equals the one its `source.json` recorded.

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const FormVersionManifest = z
  .strictObject({
    formCode: FormCode,
    version: FormVersion,
    validFrom: isoDate.nullable(),
    validUntil: isoDate.nullable(),
    /** Where the effective dates were reviewed; null while both are null. */
    validitySource: z.string().min(1).nullable(),
    sha256,
  })
  .superRefine((manifest, ctx) => {
    const dated = manifest.validFrom !== null || manifest.validUntil !== null;
    if (dated !== (manifest.validitySource !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["validitySource"],
        params: { code: "validity_source" },
      });
    }
    const { validFrom, validUntil } = manifest;
    if (validFrom !== null && validUntil !== null && compareIsoDates(validFrom, validUntil) > 0) {
      ctx.addIssue({ code: "custom", path: ["validUntil"], params: { code: "range_reversed" } });
    }
  });
export type FormVersionManifest = z.infer<typeof FormVersionManifest>;

type Validity = {
  formCode: FormCode;
  version: string;
  validFrom: IsoDate | null;
  validUntil: IsoDate | null;
};

/** In use on `today` (the Berlin date of the request): `validFrom` null or ≤ today, `validUntil` null or ≥ today. */
export function isFormVersionInUse(entry: Validity, today: IsoDate): boolean {
  return (
    (entry.validFrom === null || compareIsoDates(entry.validFrom, today) <= 0) &&
    (entry.validUntil === null || compareIsoDates(entry.validUntil, today) >= 0)
  );
}

/**
 * The version generation uses (regional-variation.md, forms are versioned): the one in use on
 * `today`, or null (`form_version_unavailable`). Two versions in use at once are a registry
 * error, never a choice.
 */
export function formVersionInUse<T extends Validity>(
  entries: readonly T[],
  formCode: FormCode,
  today: IsoDate,
): T | null {
  const inUse = entries.filter(
    (entry) => entry.formCode === formCode && isFormVersionInUse(entry, today),
  );
  if (inUse.length > 1) throw new RangeError(`More than one ${formCode} version in use`);
  return inUse[0] ?? null;
}
