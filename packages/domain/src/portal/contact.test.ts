import { describe, expect, it } from "vitest";
import {
  contactKindOf,
  maskContactAddress,
  normaliseContact,
  normaliseEmail,
  normaliseMobile,
} from "./contact";

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

  it("normalises by kind", () => {
    expect(normaliseContact("email", "A@B.Example")).toBe("a@b.example");
    expect(normaliseContact("sms", "0151 00000000")).toBe("+4915100000000");
  });

  it("masks a channel so a response never carries the whole address", () => {
    expect(maskContactAddress("email", "person@example.invalid")).toBe("p…@example.invalid");
    expect(maskContactAddress("sms", "+4915100000123")).toBe("+49 … 123");
  });

  it("tells an email from a mobile in one address field", () => {
    expect(contactKindOf(" person@example.invalid")).toBe("email");
    expect(contactKindOf("0151 00000000")).toBe("sms");
  });
});
