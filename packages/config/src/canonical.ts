// Template content identity (Slice 2 plan R22), browser-safe: no imports at all, so the package
// root (migration.ts) and hash.ts, which scripts/check-template-immutability.mjs loads through
// Node's type stripping, share one canonical form.

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
