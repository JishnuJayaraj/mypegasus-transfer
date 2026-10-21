import { describe, expect, it } from "vitest";
import { fieldEncryptionKey } from "./field-encryption";

describe("fieldEncryptionKey", () => {
  it("derives a 256-bit key and its fingerprint, as the database functions take them", () => {
    const { key, keyId } = fieldEncryptionKey("a".repeat(32));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(fieldEncryptionKey("a".repeat(32))).toEqual({ key, keyId });
  });

  it("gives another root another key and fingerprint", () => {
    const one = fieldEncryptionKey("a".repeat(32));
    const other = fieldEncryptionKey("b".repeat(32));
    expect(other.key).not.toBe(one.key);
    expect(other.keyId).not.toBe(one.keyId);
  });
});
