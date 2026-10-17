import { z } from "zod";
import { LocalizedText } from "./field-schema";
import { AgenturKey } from "./model";

/** One template version of the catalog (Slice 2 plan 5.8). */
export const TemplateManifestEntry = z.strictObject({
  agenturKey: AgenturKey,
  version: z.int().min(1),
  label: LocalizedText,
  /** A fictional sample Agentur (D8); `false` when the template doesn't say. */
  sample: z.boolean(),
  /** The SHA-256 of the file's canonical JSON, lowercase hex (R22). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type TemplateManifestEntry = z.infer<typeof TemplateManifestEntry>;

/** Catalog order: by Agentur key (code units), then version. */
export function compareTemplateVersions(
  a: { agenturKey: string; version: number },
  b: { agenturKey: string; version: number },
): number {
  if (a.agenturKey !== b.agenturKey) return a.agenturKey < b.agenturKey ? -1 : 1;
  return a.version - b.version;
}

/**
 * `templates/manifest.json`, written by `pnpm generate` and drift-checked (AC-9). Its entries are
 * strictly increasing by `compareTemplateVersions`: no duplicate `(agenturKey, version)` and no
 * reordering, because the catalog pages by that key (a misplaced entry would be skipped or
 * repeated).
 */
export const TemplateManifest = z
  .strictObject({ templates: z.array(TemplateManifestEntry) })
  .superRefine(({ templates }, ctx) => {
    templates.forEach((entry, at) => {
      if (at > 0 && compareTemplateVersions(templates[at - 1]!, entry) >= 0) {
        ctx.addIssue({
          code: "custom",
          path: ["templates", at],
          message: "manifest_not_strictly_ordered: not after the previous (agenturKey, version)",
          params: { code: "manifest_not_strictly_ordered" },
        });
      }
    });
  });
export type TemplateManifest = z.infer<typeof TemplateManifest>;
