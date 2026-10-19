import { describe, expect, it } from "vitest";
import {
  importLimits,
  ImportConfirmInput,
  ImportPreview,
  ImportPreviewInput,
  ImportReportRow,
  ImportResult,
} from "./contract";

const file = "UGVyc29uYWxudW1tZXI7TmFjaG5hbWUKQlNQLTAwMDE7TXVzdGVybWFubgo=";
const decisions = { confirmWarnings: false, possibleDuplicates: {} };
const token = "a".repeat(64);

describe("the import inputs (5.11)", () => {
  it("takes a base64 file and defaults the header row to the first", () => {
    const parsed = ImportPreviewInput.parse({ file });
    expect(parsed.headerRow).toBe(1);
    expect(parsed.mapping).toBeUndefined();
  });

  it("refuses anything but base64 and an empty file", () => {
    expect(ImportPreviewInput.safeParse({ file: "not base64!" }).success).toBe(false);
    expect(ImportPreviewInput.safeParse({ file: "" }).success).toBe(false);
  });

  it("limits the header row to the first 20 rows", () => {
    expect(
      ImportPreviewInput.safeParse({ file, headerRow: importLimits.headerRowChoices }).success,
    ).toBe(true);
    expect(ImportPreviewInput.safeParse({ file, headerRow: 21 }).success).toBe(false);
    expect(ImportPreviewInput.safeParse({ file, headerRow: 0 }).success).toBe(false);
  });

  it("checks the CSV options, the country and the wave", () => {
    expect(
      ImportPreviewInput.parse({
        file,
        csv: { delimiter: "\t", encoding: "windows-1252" },
        country: " Deutschland ",
        waveId: "6f1c9a1e-3b0a-4d6e-8d75-0a4d3f0c2b11",
      }).country,
    ).toBe("Deutschland");
    expect(ImportPreviewInput.safeParse({ file, csv: { delimiter: "|" } }).success).toBe(false);
    expect(ImportPreviewInput.safeParse({ file, country: "" }).success).toBe(false);
    expect(ImportPreviewInput.safeParse({ file, waveId: "w1" }).success).toBe(false);
  });

  it("is strict about unknown fields", () => {
    expect(ImportPreviewInput.safeParse({ file, fileName: "teilnehmer.csv" }).success).toBe(false);
  });

  it("maps a column to one target; a column twice is refused with its code", () => {
    const ok = ImportPreviewInput.safeParse({
      file,
      mapping: [
        { column: 0, target: "personnelNumber" },
        { column: 1, target: "lastName" },
      ],
    });
    expect(ok.success).toBe(true);
    const twice = ImportPreviewInput.safeParse({
      file,
      mapping: [
        { column: 0, target: "personnelNumber" },
        { column: 0, target: "lastName" },
      ],
    });
    expect(twice.success).toBe(false);
    expect(twice.error?.issues[0]).toMatchObject({
      path: ["mapping", 1, "column"],
      params: { code: "column_mapped_twice" },
    });
    expect(
      ImportPreviewInput.safeParse({ file, mapping: [{ column: 50, target: "phone" }] }).success,
    ).toBe(false);
    expect(
      ImportPreviewInput.safeParse({ file, mapping: [{ column: 0, target: "iban" }] }).success,
    ).toBe(false);
  });

  it("needs the mapping, the decisions and the token to confirm", () => {
    const mapping = [{ column: 0, target: "personnelNumber" }];
    expect(
      ImportConfirmInput.safeParse({ file, mapping, decisions, previewToken: token }).success,
    ).toBe(true);
    expect(ImportConfirmInput.safeParse({ file, mapping, decisions }).success).toBe(false);
    expect(
      ImportConfirmInput.safeParse({ file, mapping: [], decisions, previewToken: token }).success,
    ).toBe(false);
    expect(
      ImportConfirmInput.safeParse({ file, mapping, decisions, previewToken: "abc" }).success,
    ).toBe(false);
  });

  it("keys the duplicate decisions by row number", () => {
    const base = { file, mapping: [{ column: 0, target: "personnelNumber" }], previewToken: token };
    const decided = ImportConfirmInput.safeParse({
      ...base,
      decisions: { confirmWarnings: true, possibleDuplicates: { "12": "skip", "3": "create" } },
    });
    expect(decided.success).toBe(true);
    for (const key of ["0", "x", "01", "1234567"]) {
      const result = ImportConfirmInput.safeParse({
        ...base,
        decisions: { confirmWarnings: true, possibleDuplicates: { [key]: "skip" } },
      });
      expect(result.success).toBe(false);
    }
    const unknown = ImportConfirmInput.safeParse({
      ...base,
      decisions: { confirmWarnings: true, possibleDuplicates: { "2": "merge" } },
    });
    expect(unknown.success).toBe(false);
  });
});

describe("the import answers", () => {
  it("accepts a preview without a report", () => {
    const preview = {
      format: "csv",
      sheets: [],
      sheet: null,
      csv: { delimiter: ";", encoding: "utf-8" },
      headerRow: 1,
      headers: ["Personalnummer"],
      headerLooksLikeData: false,
      suggestedMapping: [{ column: 0, target: "personnelNumber", source: "builtin" }],
      mapping: [],
      missingTargets: ["lastName", "address"],
      mappingIssues: [
        { row: null, target: "lastName", code: "required_missing", severity: "error" },
      ],
      report: null,
      previewToken: null,
    };
    expect(ImportPreview.safeParse(preview).success).toBe(true);
    expect(ImportPreview.safeParse({ ...preview, previewToken: "x" }).success).toBe(false);
  });

  it("shows an update with the old and the new value, and a kept value", () => {
    const row = {
      row: 4,
      outcome: "update",
      personnelNumber: "BSP-0001",
      issues: [{ row: 4, target: "address", code: "kept_existing", severity: "warning" }],
      changes: [{ target: "phone", old: null, new: "0151 5550101" }],
      kept: [{ target: "address", value: "Musterstraße 1, 99999 Beispielstadt, DE" }],
    };
    expect(ImportReportRow.parse(row)).toEqual(row);
  });

  it("counts the four results", () => {
    const result = { created: 1, updated: 2, unchanged: 3, skipped: 4, mappingSaved: false };
    expect(ImportResult.parse(result)).toEqual(result);
    expect(ImportResult.safeParse({ ...result, created: -1 }).success).toBe(false);
    // Whether the mapping was saved is always said (R44).
    expect(
      ImportResult.safeParse({ created: 1, updated: 2, unchanged: 3, skipped: 4 }).success,
    ).toBe(false);
  });
});
