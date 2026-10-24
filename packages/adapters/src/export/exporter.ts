// Versioned CSV exports (ADR-0006; data-protection.md, exports): `;`-separated, UTF-8 with BOM,
// a header row, CRLF, quoted where needed; a cell that a spreadsheet would read as a formula
// (starting with `=`, `+`, `-`, `@`, a tab or a carriage return, Q159) gets a leading `'`.

export type ExportCell = string | number | null;
export type CsvExport = {
  /** The export's kind and its format version: the file is `<kind>-v<version>.csv`. */
  kind: string;
  version: number;
  columns: readonly { key: string; label: string }[];
  rows: readonly Readonly<Record<string, ExportCell>>[];
};
export type ExportFile = { fileName: string; contentType: string; content: Uint8Array };

export interface Exporter {
  export(data: CsvExport): ExportFile;
}

const formulaStart = /^[=+\-@\t\r]/;

/** One cell: neutralised against formulas, then quoted if it holds `;`, `"` or a line break. */
export function csvCell(value: ExportCell): string {
  const text = value === null ? "" : String(value);
  const safe = formulaStart.test(text) ? `'${text}` : text;
  return /[;"\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export class CsvExporter implements Exporter {
  export({ kind, version, columns, rows }: CsvExport): ExportFile {
    if (!/^[a-z0-9-]+$/.test(kind) || !Number.isInteger(version) || version < 1) {
      throw new RangeError("Invalid export kind or version");
    }
    const lines = [
      columns.map(({ label }) => csvCell(label)),
      ...rows.map((row) => columns.map(({ key }) => csvCell(row[key] ?? null))),
    ].map((cells) => cells.join(";"));
    return {
      fileName: `${kind}-v${version}.csv`,
      contentType: "text/csv; charset=utf-8",
      content: new TextEncoder().encode(`﻿${lines.join("\r\n")}\r\n`),
    };
  }
}
