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

/** `templates/manifest.json`, written by `pnpm generate` and drift-checked (AC-9). */
export const TemplateManifest = z.strictObject({ templates: z.array(TemplateManifestEntry) });
export type TemplateManifest = z.infer<typeof TemplateManifest>;
