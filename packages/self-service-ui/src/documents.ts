import { ApiProblemError } from "@transfer/api-client";
import type {
  DocumentList,
  DocumentOpening,
  DocumentUploadInput,
  DocumentView,
} from "@transfer/domain";

// Documents in the wizard (data-protection.md, documents and uploads; ADR-0010, documents): the
// participant's own routes in the portal, the assisted-mode routes for staff. The file is read
// into base64 in memory and sent once; nothing is kept in browser storage and nothing is
// previewed. Opening asks the API for a short-lived same-origin link and then navigates there (a
// download), so the file never passes through a `blob:` URL.

/**
 * Where "Unterlagen" lists, adds, opens and (the participant only) deletes documents. Each call
 * throws the API client's problem on refusal.
 */
export interface DocumentSource {
  /** The query key of the list (one per participant view). */
  queryKey: readonly unknown[];
  list(): Promise<DocumentList>;
  upload(input: DocumentUploadInput): Promise<DocumentView>;
  open(documentId: string): Promise<DocumentOpening>;
  /** Absent where deletion stays elsewhere: staff in assisted mode delete on the staff tab. */
  remove?(documentId: string): Promise<void>;
}

/** The codes a refused document request names, each with its message. */
export const documentErrorCodes = [
  "document_type_not_supported",
  "file_empty",
  "file_too_large",
  "file_type_not_allowed",
  "file_infected",
  "file_unscannable",
  "file_name_invalid",
  "document_limit",
  "document_reviewed",
  "document_accepted",
  "participation_closed",
  "rate_limited",
  "upload_busy",
  "scan_unavailable",
  "storage_unavailable",
] as const;
export type DocumentErrorCode = (typeof documentErrorCodes)[number];

export type DocumentFailure =
  /** The session ended (`401`), or the staff's assisted mode did (`403 assisted_mode_required`). */
  | { kind: "expired" }
  /** The document is gone (`404`): deleted elsewhere, or no longer visible. */
  | { kind: "gone" }
  | { kind: "forbidden" }
  | { kind: "refused"; code: DocumentErrorCode }
  | { kind: "failed" };

/** What a refused document request means for the page (ADR-0010 problems, the codes of 4b-2). */
export function documentFailureOf(error: unknown): DocumentFailure {
  if (!(error instanceof ApiProblemError)) return { kind: "failed" };
  const code = error.problem.errors?.[0]?.code;
  if (error.status === 401) return { kind: "expired" };
  if (error.status === 403) {
    return code === "assisted_mode_required" ? { kind: "expired" } : { kind: "forbidden" };
  }
  if (error.status === 404) return { kind: "gone" };
  const known = (documentErrorCodes as readonly string[]).includes(code ?? "");
  return known ? { kind: "refused", code: code as DocumentErrorCode } : { kind: "failed" };
}

/** The file as base64, read in memory (no preview, nothing stored). */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(",") + 1));
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("The file could not be read")),
    );
    reader.readAsDataURL(file);
  });
}

const KB = 1024;
const MB = 1024 * 1024;

/** A file size as people read it: `350 kB`, `1,2 MB` (`1.2 MB` in English), `10 MB`. */
export function formatFileSize(bytes: number, language: "de" | "en" = "de"): string {
  const locale = language === "en" ? "en-GB" : "de-DE";
  if (bytes < MB) {
    return `${new Intl.NumberFormat(locale).format(Math.max(1, Math.round(bytes / KB)))} kB`;
  }
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return `${format.format(bytes / MB)} MB`;
}
