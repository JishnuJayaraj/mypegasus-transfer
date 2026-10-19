import { importLimits, type ImportCell } from "@transfer/domain";
import { parse as parseCsv } from "csv-parse/sync";
import readXlsxFile from "read-excel-file/node";
import { ImportFileError } from "./errors";
import { checkZipDirectory, hasZipSignature, verifyZipSizes } from "./zip-check";

// What the parse worker does (Slice 2 plan 5.11, spike S1): bytes in, a grid of cells out. Imported
// only by the worker (`parse-worker.ts`) and by tests; the API process reaches it through
// `parseSpreadsheet()`, which never parses a workbook in-process. Nothing here logs or throws a
// message from the file: refusals are `ImportFileError` codes.

export type Delimiter = ";" | "," | "\t";
export type Encoding = "utf-8" | "windows-1252";

export type ParseRequest = {
  bytes: Uint8Array;
  /** The sheet of a workbook (default the first). */
  sheet?: string | undefined;
  /** Overrides what was detected for a CSV file. */
  csv?: { delimiter?: Delimiter | undefined; encoding?: Encoding | undefined } | undefined;
};

export type ParsedSheet = {
  format: "xlsx" | "csv";
  /** Every sheet of the workbook, hidden ones included; empty for a CSV. */
  sheets: string[];
  sheet: string | null;
  csv: { delimiter: Delimiter; encoding: Encoding } | null;
  /** The cells of the sheet from its first row, trailing empty cells and rows dropped. */
  rows: ImportCell[][];
};

/** The header row may be any of the first 20, and the data rows follow it. */
const maxRows = importLimits.dataRows + importLimits.headerRowChoices;

const isEmpty = (cell: ImportCell) => cell === "";

/** Applies the row, column and cell limits; returns the grid without trailing empty rows. */
function limited(grid: ImportCell[][]): ImportCell[][] {
  const rows = grid.map((row) => {
    let end = row.length;
    while (end > 0 && isEmpty(row[end - 1]!)) end -= 1;
    return row.slice(0, end);
  });
  while (rows.length > 0 && rows.at(-1)!.length === 0) rows.pop();
  if (rows.length === 0) throw new ImportFileError("file_empty");
  if (rows.length > maxRows) throw new ImportFileError("too_many_rows");
  for (const row of rows) {
    if (row.length > importLimits.columns) throw new ImportFileError("too_many_columns");
    for (const cell of row) {
      if (typeof cell === "string" && [...cell].length > importLimits.cellCharacters) {
        throw new ImportFileError("cell_too_long");
      }
    }
  }
  return rows;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An Excel date cell: the UTC components (the library reads the serial as UTC), a time flagged. */
function dateCell(value: Date): ImportCell {
  if (Number.isNaN(value.getTime())) return { date: "0000-00-00" };
  const date = `${String(value.getUTCFullYear()).padStart(4, "0")}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  const time =
    value.getUTCHours() +
      value.getUTCMinutes() +
      value.getUTCSeconds() +
      value.getUTCMilliseconds() >
    0;
  return time ? { date, time: true } : { date };
}

type Raw = string | { number: string } | boolean | Date | null | undefined;

function xlsxCell(value: Raw): ImportCell {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return dateCell(value);
  if (typeof value === "object") return { number: value.number };
  // A TRUE/FALSE cell is text to the import (never a valid date or identifier).
  return typeof value === "boolean" ? String(value) : value;
}

async function parseWorkbook(request: ParseRequest): Promise<ParsedSheet> {
  verifyZipSizes(request.bytes, checkZipDirectory(request.bytes));
  let sheets;
  try {
    // A numeric cell keeps its stored value as text, marked as numeric (R24).
    sheets = await readXlsxFile(Buffer.from(request.bytes), {
      parseNumber: (stored: string) => ({ number: stored }),
    });
  } catch (error) {
    if (error instanceof ImportFileError) throw error;
    throw new ImportFileError("unsupported_file");
  }
  const first = sheets[0];
  if (!first) throw new ImportFileError("file_empty");
  const chosen =
    request.sheet === undefined ? first : sheets.find((s) => s.sheet === request.sheet);
  if (!chosen) throw new ImportFileError("sheet_not_found");
  return {
    format: "xlsx",
    sheets: sheets.map((s) => s.sheet),
    sheet: chosen.sheet,
    csv: null,
    rows: limited(chosen.data.map((row) => (row as Raw[]).map(xlsxCell))),
  };
}

const delimiters: readonly Delimiter[] = [";", ",", "\t"];

function decode(
  bytes: Uint8Array,
  wanted: Encoding | undefined,
): { text: string; encoding: Encoding } {
  if (wanted !== "windows-1252") {
    try {
      // Strict UTF-8; a byte order mark is dropped.
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
    } catch {
      if (wanted === "utf-8") throw new ImportFileError("encoding_invalid");
    }
  }
  return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
}

const csvOptions = { relax_column_count: true, relax_quotes: true, skip_empty_lines: false };

/** The delimiter that splits the first rows into the most columns; `;` for a single column. */
function detectDelimiter(text: string): Delimiter {
  const sample = text.slice(0, 64 * 1024);
  let best: Delimiter = ";";
  let most = 1;
  for (const delimiter of delimiters) {
    try {
      const records = parseCsv(sample, { ...csvOptions, delimiter, to: 50 }) as string[][];
      const columns = Math.max(...records.map((r) => r.length));
      if (columns > most) [best, most] = [delimiter, columns];
    } catch {
      // A sample cut inside a quoted cell: this delimiter just doesn't win.
    }
  }
  return best;
}

function parseCsvFile(request: ParseRequest): ParsedSheet {
  // Text has no NUL bytes; a binary file or UTF-16 text does.
  if (request.bytes.subarray(0, 8192).includes(0)) throw new ImportFileError("unsupported_file");
  const { text, encoding } = decode(request.bytes, request.csv?.encoding);
  const delimiter = request.csv?.delimiter ?? detectDelimiter(text);
  let records: string[][];
  try {
    records = parseCsv(text, { ...csvOptions, delimiter }) as string[][];
  } catch {
    throw new ImportFileError("csv_malformed");
  }
  return {
    format: "csv",
    sheets: [],
    sheet: null,
    csv: { delimiter, encoding },
    rows: limited(records),
  };
}

/** Parses a workbook (a ZIP) or a CSV file; throws `ImportFileError` for anything else. */
export async function parseBytes(request: ParseRequest): Promise<ParsedSheet> {
  if (request.bytes.length === 0) throw new ImportFileError("file_empty");
  return hasZipSignature(request.bytes) ? parseWorkbook(request) : parseCsvFile(request);
}
