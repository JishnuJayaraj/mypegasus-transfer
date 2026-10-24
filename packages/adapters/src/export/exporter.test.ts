import { describe, expect, it } from "vitest";
import { csvCell, CsvExporter } from "./exporter";

const decode = (content: Uint8Array) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(content);

describe("CsvExporter (ADR-0006; data-protection.md, exports)", () => {
  it("writes a versioned CSV: BOM, header row, `;`, CRLF", () => {
    const file = new CsvExporter().export({
      kind: "kug200b-batch-index",
      version: 1,
      columns: [
        { key: "lastName", label: "Nachname" },
        { key: "firstName", label: "Vorname" },
        { key: "count", label: "Anzahl" },
      ],
      rows: [
        { lastName: "Doğan-Großmann", firstName: "Łucja", count: 2 },
        { lastName: "Brenner", firstName: null },
      ],
    });
    expect(file.fileName).toBe("kug200b-batch-index-v1.csv");
    expect(file.contentType).toBe("text/csv; charset=utf-8");
    expect(decode(file.content)).toBe(
      "﻿Nachname;Vorname;Anzahl\r\nDoğan-Großmann;Łucja;2\r\nBrenner;;\r\n",
    );
  });

  it("quotes cells holding `;`, quotes or line breaks", () => {
    expect(csvCell('Werk "Nord"; Halle 2')).toBe('"Werk ""Nord""; Halle 2"');
    expect(csvCell("Zeile 1\nZeile 2")).toBe('"Zeile 1\nZeile 2"');
  });

  it("neutralises cells a spreadsheet would read as a formula (Q159)", () => {
    expect(["=SUM(A1)", "+49 30", "-5", "@cmd", "\tx", "\rx"].map(csvCell)).toEqual([
      "'=SUM(A1)",
      "'+49 30",
      "'-5",
      "'@cmd",
      "'\tx",
      `"'\rx"`,
    ]);
    expect(csvCell(-5)).toBe("'-5");
    expect(csvCell("a=b")).toBe("a=b");
  });

  it("refuses an invalid kind or version", () => {
    const exporter = new CsvExporter();
    for (const [kind, version] of [
      ["Teilnehmer Liste", 1],
      ["list", 0],
      ["list", 1.5],
    ] as const) {
      expect(() => exporter.export({ kind, version, columns: [], rows: [] })).toThrow(RangeError);
    }
  });
});
