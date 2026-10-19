import { inflateRawSync } from "node:zlib";
import { ImportFileError } from "./errors";

// The ZIP central-directory check for `.xlsx` (Slice 2 plan 5.11, D6, spike S1): run for every
// workbook before anything is expanded. The declared sizes are read from the central directory
// alone (no byte is inflated): entry count, total expanded size and the ratio per entry. A zip
// that lies about its sizes is caught by `verifyZipSizes`, which inflates each entry with its
// declared size as the hard cap (`maxOutputLength`), so a bomb never allocates more than the
// check allowed. Both throw `file_too_complex`, never a message from the file.

/** The declared expanded total, the entries and the ratio an ordinary workbook stays far below. */
export const zipLimits = { entries: 1000, expandedBytes: 50 * 1024 * 1024, ratio: 100 } as const;

export type ZipEntry = {
  name: string;
  method: 0 | 8;
  compressedSize: number;
  size: number;
  /** Offset of the entry's local header. */
  offset: number;
};

const tooComplex = () => new ImportFileError("file_too_complex");

const endOfDirectory = 0x06054b50;
const directoryEntry = 0x02014b50;
const localHeader = 0x04034b50;

/** Whether the bytes start like a ZIP archive (local header, or the end of an empty one). */
export const hasZipSignature = (bytes: Uint8Array) =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));

/** Reads the central directory and applies the declared limits; returns the entries. */
export function checkZipDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-directory record sits within the last 22 + 65535 (comment) bytes.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === endOfDirectory) {
      end = at;
      break;
    }
  }
  if (end < 0) throw tooComplex();
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  // ZIP64 (and an archive over 4 GB) is far beyond the 5 MB limit: not supported.
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw tooComplex();
  }
  if (count === 0 || count > zipLimits.entries || directoryOffset + directorySize > end) {
    throw tooComplex();
  }

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let cursor = directoryOffset;
  let expanded = 0;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== directoryEntry) throw tooComplex();
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true);
    const name = Buffer.from(bytes.subarray(cursor + 46, cursor + 46 + nameLength)).toString(
      "latin1",
    );
    cursor += 46 + nameLength + extraLength + commentLength;
    // Encrypted entries, other methods than stored/deflate, ZIP64 sizes and duplicate names
    // (two readers could pick different ones) are refused.
    if (flags & 1 || (method !== 0 && method !== 8) || cursor > end) throw tooComplex();
    if (compressedSize === 0xffffffff || size === 0xffffffff || names.has(name)) throw tooComplex();
    if (offset + 30 > bytes.length || compressedSize > bytes.length) throw tooComplex();
    if (
      method === 0 ? size !== compressedSize : size > 0 && size > compressedSize * zipLimits.ratio
    ) {
      throw tooComplex();
    }
    names.add(name);
    expanded += size;
    if (expanded > zipLimits.expandedBytes) throw tooComplex();
    entries.push({ name, method, compressedSize, size, offset });
  }
  return entries;
}

/**
 * Inflates every entry up to its declared size and requires exactly that size: a zip whose real
 * content is larger than declared (or smaller) is refused, and nothing larger than the checked
 * total is ever allocated. Run in the parse worker (time and memory limited).
 */
export function verifyZipSizes(bytes: Uint8Array, entries: readonly ZipEntry[]): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const entry of entries) {
    if (view.getUint32(entry.offset, true) !== localHeader) throw tooComplex();
    const start =
      entry.offset +
      30 +
      view.getUint16(entry.offset + 26, true) +
      view.getUint16(entry.offset + 28, true);
    const end = start + entry.compressedSize;
    if (end > bytes.length) throw tooComplex();
    const data = bytes.subarray(start, end);
    if (entry.method === 0) continue;
    let inflated: Buffer;
    try {
      inflated = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      // Larger than declared (ERR_BUFFER_TOO_LARGE) or not a deflate stream: both are refused.
      throw tooComplex();
    }
    if (inflated.length !== entry.size) throw tooComplex();
  }
}
