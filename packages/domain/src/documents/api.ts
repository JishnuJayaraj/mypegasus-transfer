import { z } from "zod";
import { DocumentType, documentTypeCatalog } from "./catalog";
import { DocumentMediaType } from "./files";
import { DocumentDeleteReason, DocumentReviewReason, DocumentReviewState } from "./state";

// The documents API (ADR-0010, uploads; data-protection.md, uploads): metadata and capabilities,
// never content, a hash or a key. The file travels base64 in JSON on the upload routes only, and
// back as a download from the opening's link.

const utc = z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" });

/**
 * The types the upload routes take (Q142, *assumed*): those whose operations are decided; any
 * other type is `document_type_not_supported` until its slice.
 */
export const uploadableDocumentTypes: readonly DocumentType[] = documentTypeCatalog.types
  .filter((entry) => entry.operations !== "undecided")
  .map((entry) => entry.type);

/** Where an upload came from, as `document_added` records it. */
export const DocumentSource = z.enum(["portal", "staff", "assisted"]);
export type DocumentSource = z.infer<typeof DocumentSource>;

/**
 * An upload (ADR-0010, "uploads are JSON"): the type, the original file name (kept only for the
 * types whose catalog entry says so) and the file as base64. The client's MIME type isn't asked
 * for: the type is detected from the content.
 */
export const DocumentUploadInput = z
  .strictObject({
    type: DocumentType,
    fileName: z.string().min(1).max(1000),
    content: z.base64().meta({ description: "The file, base64; decoded at most 10 MB" }),
  })
  .meta({ id: "DocumentUploadInput" });
export type DocumentUploadInput = z.infer<typeof DocumentUploadInput>;

export const DocumentCapabilities = z
  .strictObject({ open: z.boolean(), review: z.boolean(), delete: z.boolean() })
  .meta({ id: "DocumentCapabilities" });
export type DocumentCapabilities = z.infer<typeof DocumentCapabilities>;

/** One live document's metadata as the viewer may see it. */
export const DocumentView = z
  .strictObject({
    id: z.uuid(),
    type: DocumentType,
    mediaType: DocumentMediaType,
    sizeBytes: z.int().min(1),
    /** Confidential metadata, only for the types that keep it (Q148). */
    fileName: z.string().nullable(),
    addedAt: utc,
    /** Who added it, by kind: the participant, or staff (as themselves or on their behalf). */
    addedBy: z.enum(["participant", "staff"]),
    onBehalf: z.boolean(),
    review: z.strictObject({
      state: DocumentReviewState,
      reasonCode: DocumentReviewReason.nullable(),
      reviewedAt: utc.nullable(),
    }),
    capabilities: DocumentCapabilities,
  })
  .meta({ id: "Document" });
export type DocumentView = z.infer<typeof DocumentView>;

export const DocumentLimitsView = z
  .strictObject({
    maxBytes: z.int(),
    maxLiveDocuments: z.int(),
    maxUploadsPerHour: z.int(),
  })
  .meta({ id: "DocumentLimits" });

/** A participation's live documents of the types the viewer may read, oldest first. */
export const DocumentList = z
  .strictObject({
    documents: z.array(DocumentView),
    /** The types the viewer may upload now, in this mode. */
    addableTypes: z.array(DocumentType),
    limits: DocumentLimitsView,
  })
  .meta({ id: "DocumentList" });
export type DocumentList = z.infer<typeof DocumentList>;

/** The opening's link: same origin, bound to the session that asked, valid 60 s (Q147). */
export const DocumentOpening = z
  .strictObject({ url: z.string().startsWith("/api/v1/document-content/"), expiresAt: utc })
  .meta({ id: "DocumentOpening" });
export type DocumentOpening = z.infer<typeof DocumentOpening>;

/** Accept, or reject with a reason code; once and final (process-and-lifecycle.md). */
export const DocumentReviewInput = z
  .strictObject({
    decision: z.enum(["accepted", "rejected"]),
    reasonCode: DocumentReviewReason.optional(),
  })
  .refine(({ decision, reasonCode }) => (decision === "rejected") === (reasonCode !== undefined), {
    message: "A rejection needs a reason code, an acceptance none",
    params: { code: "reason_code_mismatch" },
    path: ["reasonCode"],
  })
  .meta({ id: "DocumentReviewInput" });
export type DocumentReviewInput = z.infer<typeof DocumentReviewInput>;

/** A staff deletion names why. */
export const DocumentDeleteQuery = z.strictObject({ reasonCode: DocumentDeleteReason });

/** The opening's token: 32 random bytes, base64url. */
export const DocumentContentParams = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
