import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalJson } from "./hash";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const template = {
  kind: "regional_template",
  version: 1,
  label: { de: "Beispiel", en: "Sample" },
  settings: { agentur_submission: { leadTimeDays: 10, originalRequired: false } },
  rules: { data_collection: [{ id: "a", kind: "required" }, { id: "b" }] },
  sample: true,
  note: null,
};

describe("canonicalJson (R22)", () => {
  it("sorts object keys at every level and writes no whitespace", () => {
    expect(
      canonicalJson({ b: 1, a: [true, null, "x", { d: 2, c: [] }], c: { f: 1.5, e: {} } }),
    ).toBe('{"a":[true,null,"x",{"c":[],"d":2}],"b":1,"c":{"e":{},"f":1.5}}');
  });

  it("sorts keys by UTF-16 code units, like JSON key order in RFC 8785", () => {
    expect(canonicalJson({ b: 0, B: 0, ä: 0, a: 0, "€": 0, "😀": 0, _: 0 })).toBe(
      '{"B":0,"_":0,"a":0,"b":0,"ä":0,"€":0,"😀":0}',
    );
  });

  it("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("writes strings and numbers as JSON.stringify does", () => {
    expect(canonicalJson(['"\\\n\u0000', 1e21, 0.1, -0, 10])).toBe(
      String.raw`["\"\\\n\u0000",1e+21,0.1,0,10]`,
    );
  });

  it("takes objects without a prototype", () => {
    const value = Object.assign(Object.create(null) as object, { b: 1, a: 2 });
    expect(canonicalJson(value)).toBe('{"a":2,"b":1}');
  });

  it("keeps an own __proto__ key as data, as JSON.parse does", () => {
    expect(canonicalJson(JSON.parse('{"__proto__":{"x":1},"a":0}'))).toBe(
      '{"__proto__":{"x":1},"a":0}',
    );
  });

  it.each([
    ["undefined", undefined],
    ["an undefined property", { a: undefined }],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a bigint", 1n],
    ["a function", () => 1],
    ["a symbol", Symbol("x")],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["an array hole", [1, , 2]], // oxlint-disable-line no-sparse-arrays
  ])("refuses %s, which isn't JSON", (_, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});

describe("canonicalHash (R22)", () => {
  it("is the SHA-256 of the canonical JSON, as lowercase hex", () => {
    expect(canonicalHash({})).toBe(
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
    expect(canonicalHash(template)).toBe(sha256(canonicalJson(template)));
  });

  it("doesn't change with formatting or key order (AC-9)", () => {
    const pretty = JSON.stringify(template, null, 2);
    const reordered = `{ "sample": true, "note": null,\n\t"rules": {"data_collection": [{"kind":"required","id":"a"},{"id":"b"}]},
      "settings": {"agentur_submission": {"originalRequired": false, "leadTimeDays": 10.0}},
      "label": {"en": "Sample", "de": "Beispiel"}, "version": 1, "kind": "regional_template" }`;
    const hash = canonicalHash(template);
    expect(canonicalHash(JSON.parse(pretty))).toBe(hash);
    expect(canonicalHash(JSON.parse(JSON.stringify(template)))).toBe(hash);
    expect(canonicalHash(JSON.parse(reordered))).toBe(hash);
  });

  it.each([
    ["a value", { ...template, version: 2 }],
    ["a value's type", { ...template, version: "1" }],
    ["a nested value", { ...template, label: { de: "Beispiel ", en: "Sample" } }],
    ["a key", { ...template, Sample: true, sample: undefined }],
    ["an added key", { ...template, extra: false }],
    ["a removed key", { ...template, note: undefined }],
    ["null to false", { ...template, note: false }],
    [
      "array order",
      { ...template, rules: { data_collection: [{ id: "b" }, { id: "a", kind: "required" }] } },
    ],
  ])("changes with %s (AC-9)", (_, changed) => {
    const parsed: unknown = JSON.parse(JSON.stringify(changed));
    expect(canonicalHash(parsed)).not.toBe(canonicalHash(template));
  });
});
