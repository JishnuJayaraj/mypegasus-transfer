import { z } from "zod";
import type { IsoDate } from "../iso-date";
import type { DocumentType } from "./catalog";

/**
 * The file types a document may have (Q143, *assumed*; data-protection.md, uploads): PDF, JPEG
 * and PNG, told apart by their content. The client's MIME type and the file name's extension
 * are never consulted; Office files, HEIC, archives, SVG and HTML are refused.
 */
export const DocumentMediaType = z.enum(["application/pdf", "image/jpeg", "image/png"]);
export type DocumentMediaType = z.infer<typeof DocumentMediaType>;

/** Per file and per participation (Q143, *assumed*). */
export const documentLimits = {
  maxBytes: 10 * 1024 * 1024,
  /** Live documents: deleted ones don't count. */
  maxLiveDocuments: 50,
  /** Uploads per participation within an hour, by anyone. */
  maxUploadsPerHour: 20,
} as const;

const signatures: readonly [DocumentMediaType, readonly number[]][] = [
  ["application/pdf", [0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
];

/** The type by its magic bytes at offset 0, or null for an empty or any other file. */
export function detectFileType(content: Uint8Array): DocumentMediaType | null {
  const match = signatures.find(([, magic]) => magic.every((byte, i) => content[i] === byte));
  return match?.[0] ?? null;
}

const extensions: Record<DocumentMediaType, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

// Control characters, and the bidirectional controls that can disguise an extension.
const controls = /[\p{Cc}\p{Bidi_Control}]/gu;

/**
 * An uploaded file's original name as stored (Q148, *assumed*): NFC, path parts and control
 * characters dropped, trimmed; null unless 1–200 characters remain. It is confidential metadata,
 * kept only for the types whose catalog entry says `fileName`, and never goes into an audit
 * entry, log, object key or error.
 */
export function documentFileName(name: string): string | null {
  const base = name.normalize("NFC").split(/[/\\]/).at(-1)!;
  const cleaned = base.replace(controls, "").trim();
  const length = [...cleaned].length;
  return length >= 1 && length <= 200 ? cleaned : null;
}

/** The download name of a document that keeps no file name (Q148): `<type>-<date>.<ext>`. */
export function generatedDocumentFileName(
  type: DocumentType,
  date: IsoDate,
  mediaType: DocumentMediaType,
): string {
  return `${type}-${date}.${extensions[mediaType]}`;
}
