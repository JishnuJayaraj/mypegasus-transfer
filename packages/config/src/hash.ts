// Template content identity (Slice 2 plan R22). Node only. scripts/check-template-immutability.mjs
// imports this file through Node's type stripping, so it stays erasable TypeScript that imports
// nothing but `node:` modules and ./canonical.ts (by its .ts name, as Node resolves it).

import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";

export { canonicalJson };

/** The SHA-256 of `canonicalJson(value)`, lowercase hex: a template version's identity (R22). */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
