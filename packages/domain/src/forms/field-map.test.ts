import { describe, expect, it } from "vitest";
import { FieldMap, mappedFieldNames } from "./field-map";
import { testMap } from "./testing/maps";

const codes = (value: unknown) => {
  const result = FieldMap.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((issue) => (issue as { params?: { code?: string } }).params?.code);
};

const base = { ...testMap };
const text = (key: string, field: string) => ({
  key,
  label: key,
  kind: "text",
  fields: [field],
  required: false,
  box: { width: 10, height: 10 },
  multiline: false,
});
const table = (overrides: object) => ({
  kind: "table",
  key: "rows",
  label: "Rows",
  required: false,
  rows: 1,
  columns: [{ key: "on", label: "On", kind: "date", fields: ["dateOn"] }],
  dateRanges: [],
  timeRanges: [],
  ...overrides,
});

describe("FieldMap (ADR-0009, field maps)", () => {
  it("parses a map and lists every AcroForm field it fills or leaves blank", () => {
    expect(mappedFieldNames(testMap)).toContain("txtFirst2");
    expect(mappedFieldNames(testMap)).toContain("dateS3");
    expect(mappedFieldNames(testMap).at(-1)).toBe("txtSignature");
  });

  it("refuses a key or an AcroForm field used twice", () => {
    expect(codes({ ...base, entries: [...base.entries, text("firstName", "txtOther")] })).toEqual([
      "duplicate_key",
    ]);
    expect(codes({ ...base, entries: [...base.entries, text("other", "txtFirst")] })).toEqual([
      "field_mapped_twice",
    ]);
    expect(codes({ ...base, entries: [...base.entries, table({ key: "sessions" })] })).toEqual([
      "duplicate_key",
    ]);
    const twice = { key: "on", label: "Again", kind: "date", fields: ["dateAgain"] };
    expect(
      codes({
        ...base,
        entries: [...base.entries, table({ columns: [...table({}).columns, twice] })],
      }),
    ).toEqual(["duplicate_key"]);
    expect(
      codes({ ...base, neverFilled: [...base.neverFilled, { field: "txtRv", reason: "agentur" }] }),
    ).toEqual(["field_mapped_twice"]);
  });

  it("checks a table's rows, marker and ranges", () => {
    expect(codes({ ...base, entries: [...base.entries, table({ rows: 2 })] })).toEqual([
      "column_rows_mismatch",
    ]);
    expect(codes({ ...base, entries: [...base.entries, table({ markerColumn: "nope" })] })).toEqual(
      ["unknown_key"],
    );
    const ranges = {
      dateRanges: [{ from: "on", to: "nope" }],
      timeRanges: [{ from: "on", to: "on" }],
    };
    expect(codes({ ...base, entries: [...base.entries, table(ranges)] })).toEqual([
      "range_kind_mismatch",
      "range_kind_mismatch",
    ]);
  });

  it("checks the map's ranges, plausibility and Anlage keys and the font sizes", () => {
    expect(codes({ ...base, dateRanges: [{ from: "firstName", to: "beeTo" }] })).toEqual([
      "range_kind_mismatch",
    ]);
    expect(
      codes({ ...base, plausibility: { birthDate: "firstName", ageAt: "x", entryDate: "y" } }),
    ).toEqual(["unknown_key", "unknown_key", "unknown_key"]);
    expect(codes({ ...base, anlage: { ...base.anlage, firstName: "birthDate" } })).toEqual([
      "unknown_key",
    ]);
    expect(codes({ ...base, anlage: null, plausibility: undefined })).toEqual([]);
    expect(codes({ ...base, minFontSize: 11 })).toEqual(["font_size_order"]);
  });
});
