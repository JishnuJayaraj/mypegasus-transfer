import { importLimits, type ImportCell } from "@transfer/domain";
import { ImportFileError } from "./errors";
import type { ParsedSheet } from "./parse-core";

// From the parsed sheet to what the import works on: the header row the PL chose and the data
// rows below it, numbered as in the file (5.11).

/** The file's bytes; more than 5 MB decoded is refused (the body limit allows base64 of 6 MB). */
export function decodeFile(base64: string): Buffer {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > importLimits.fileBytes) throw new ImportFileError("file_too_large");
  return bytes;
}

export type Grid = {
  headerRow: number;
  headers: string[];
  /** The non-empty data rows with their row number in the file. */
  rows: { row: number; cells: ImportCell[] }[];
};

const text = (cell: ImportCell | undefined): string => {
  if (cell === undefined) return "";
  if (typeof cell === "string") return cell.trim();
  return "number" in cell ? cell.number : cell.date;
};

const blank = (cell: ImportCell) => typeof cell === "string" && cell.trim() === "";

/**
 * The header row is one row among the first 20 (default the first); rows above it are dropped
 * unread, the rows below it are data (empty ones skipped). The header may not be empty and the
 * data rows may not exceed 5,000.
 */
export function toGrid(parsed: ParsedSheet, headerRow: number): Grid {
  const header = parsed.rows[headerRow - 1];
  if (!header || header.every(blank)) throw new ImportFileError("header_row_invalid");
  const rows = parsed.rows
    .slice(headerRow)
    .map((cells, i) => ({ row: headerRow + 1 + i, cells }))
    .filter(({ cells }) => !cells.every(blank));
  if (rows.length > importLimits.dataRows) throw new ImportFileError("too_many_rows");
  const columns = Math.max(header.length, ...rows.map(({ cells }) => cells.length));
  return {
    headerRow,
    headers: Array.from({ length: columns }, (_, i) => text(header[i])),
    rows,
  };
}
