import { describe, expect, it } from "vitest";
import { normaliseEmail, normaliseMobile } from "./contact";

describe("private delivery address normalisation", () => {
  it("normalises email without retaining display syntax", () => {
    expect(normaliseEmail(" Person@Example.Invalid ")).toBe("person@example.invalid");
    expect(normaliseEmail("Person <person@example.invalid>")).toBeNull();
  });

  it("normalises German national and international mobile forms to E.164", () => {
    expect(normaliseMobile("0151 000-00000")).toBe("+4915100000000");
    expect(normaliseMobile("0049 (151) 00000000")).toBe("+4915100000000");
    expect(normaliseMobile("+44 7700 900123")).toBe("+447700900123");
    expect(normaliseMobile("123")).toBeNull();
  });
});
