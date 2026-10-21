import { describe, expect, it } from "vitest";
import { CROCKFORD_ALPHABET, formatActivationCode, normaliseActivationCode } from "./code";

describe("activation codes", () => {
  it("uses exactly the unambiguous Crockford alphabet", () => {
    expect(CROCKFORD_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
  });

  it("formats twelve characters in three groups", () => {
    expect(formatActivationCode("0123ABCDEFGH")).toBe("0123-ABCD-EFGH");
    expect(() => formatActivationCode("too-short")).toThrow("activation code");
  });

  it("normalises case, separators and Crockford aliases", () => {
    expect(normaliseActivationCode(" oilv-abcd efgh ")).toBe("011VABCDEFGH");
    expect(normaliseActivationCode("0123-4567-89ab")).toBe("0123456789AB");
    expect(normaliseActivationCode("0123-4567-89A!")).toBeNull();
    expect(normaliseActivationCode("0123")).toBeNull();
  });
});
