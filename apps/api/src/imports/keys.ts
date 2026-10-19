import { canonicalHash } from "@transfer/config/load";
import { normaliseHeader } from "@transfer/domain";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

// The two keyed hashes of the import (Slice 2 plan 5.11), both derived from SESSION_SECRET with
// HKDF so a leak of one never gives the other: the saved column mappings (R7) and the preview
// token. Losing the secret only loses suggestions and open previews.

const derive = (secret: string, info: string) =>
  Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), info, 32));

export const mappingKey = (secret: string) => derive(secret, "import-header-mapping:v1");
export const tokenKey = (secret: string) => derive(secret, "import-preview-token:v1");

/** The keyed hash of a normalised header; null for a header with nothing to normalise to. */
export function headerHmac(key: Buffer, header: string): string | null {
  const normalised = normaliseHeader(header);
  return normalised === "" ? null : createHmac("sha256", key).update(normalised).digest("hex");
}

/** What a preview token binds (5.11): everything that decides what a confirm would write. */
export type PreviewBinding = {
  projectId: string;
  fileHash: string;
  sheet: string | null;
  csv: { delimiter: string; encoding: string } | null;
  headerRow: number;
  mapping: { column: number; target: string }[];
  country: string | null;
  waveId: string | null;
  planDigest: string;
};

export function previewToken(key: Buffer, binding: PreviewBinding): string {
  const mapping = binding.mapping.toSorted((a, b) => a.column - b.column);
  return createHmac("sha256", key)
    .update(canonicalHash({ v: 1, ...binding, mapping }))
    .digest("hex");
}

export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
