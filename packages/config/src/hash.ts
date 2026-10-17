import { createHash } from "node:crypto";

// Template content identity (Slice 2 plan R22). Node only. scripts/check-template-immutability.mjs
// imports this file through Node's type stripping, so it stays erasable TypeScript that imports
// nothing but `node:` modules.

/**
 * Canonical JSON of a parsed JSON value: object keys sorted by UTF-16 code units at every level,
 * array order kept, strings and numbers as `JSON.stringify` writes them, no whitespace. So
 * formatting and key order never change it, and any change of content does. Anything that isn't
 * JSON (undefined, a non-finite number, a class instance, an array hole) is a `TypeError`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .toSorted()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${members.join(",")}}`;
    }
  }
  throw new TypeError(`Not a JSON value: ${typeof value}`);
}

/** The SHA-256 of `canonicalJson(value)`, lowercase hex: a template version's identity (R22). */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
