import { describe, expect, it } from "vitest";
import { CROCKFORD_ALPHABET } from "@transfer/domain";
import {
  activationCodeKey,
  deliveryAddressKey,
  generateActivationCode,
  keyedHash,
  oneTimeCodeKey,
} from "./keys";

describe("activation credential keys", () => {
  const secret = "synthetic-test-secret-that-is-at-least-32-characters";

  it("generates twelve Crockford symbols with cryptographic random bytes", () => {
    const codes = new Set(Array.from({ length: 100 }, generateActivationCode));
    expect(codes.size).toBe(100);
    for (const code of codes) {
      expect(code).toHaveLength(12);
      expect([...code].every((character) => CROCKFORD_ALPHABET.includes(character))).toBe(true);
    }
  });

  it("uses separate approved HKDF contexts", () => {
    const keys = [activationCodeKey(secret), deliveryAddressKey(secret), oneTimeCodeKey(secret)];
    expect(new Set(keys.map((key) => key.toString("hex"))).size).toBe(3);
    expect(new Set(keys.map((key) => keyedHash(key, "same-input"))).size).toBe(3);
    expect(keyedHash(keys[0]!, "same-input")).toMatch(/^[0-9a-f]{64}$/);
  });
});
