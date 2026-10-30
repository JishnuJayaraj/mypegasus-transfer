import { z } from "zod";

// Exports (data-protection.md, exports; ADR-0010, exports; Q159): a logged request
// (`export_created`) answers a link valid 60 seconds for the asking session; the download
// re-authorizes the viewer and every included item, renders the output at that moment from
// immutable inputs, stores no export file and is audited itself (`export_downloaded`).

/**
 * The kinds of export: `kug200b_print`, one print file of generated Kug 200b forms;
 * `kug200b_batch_index`, an open batch's operational index (the PL's work list, CSV), never the
 * artifact sent to the Agentur; `kug200b_batch_artifact`, the official artifact of an open batch
 * (the Kug 200a, or the alternative list the Agentur accepted); `kug200b_batch_scans`, its members'
 * accepted Kug 200b scans as one PDF (the channels `scan_email` and `upload`).
 */
export const ExportKind = z
  .enum(["kug200b_print", "kug200b_batch_index", "kug200b_batch_artifact", "kug200b_batch_scans"])
  .meta({ id: "ExportKind" });
export type ExportKind = z.infer<typeof ExportKind>;

/** The kinds over one Kug 200b batch. */
export const batchExportKinds = [
  "kug200b_batch_index",
  "kug200b_batch_artifact",
  "kug200b_batch_scans",
] as const satisfies ExportKind[];

/** The official artifacts: rechecked in full at the download, settings included (Q203 (6)). */
export const officialExportKinds = [
  "kug200b_batch_artifact",
  "kug200b_batch_scans",
] as const satisfies ExportKind[];
export type OfficialExportKind = (typeof officialExportKinds)[number];
export const isOfficialExportKind = (kind: ExportKind): kind is OfficialExportKind =>
  (officialExportKinds as readonly ExportKind[]).includes(kind);
export const isBatchExportKind = (kind: ExportKind) =>
  (batchExportKinds as readonly ExportKind[]).includes(kind);

/** The bounds (data-protection.md, exports): a print file holds at most 100 forms, a batch 200. */
export const exportLimits = {
  kug200b_print: 100,
  kug200b_batch_index: 200,
  kug200b_batch_artifact: 200,
  kug200b_batch_scans: 200,
} as const satisfies Record<ExportKind, number>;

export const ExportParams = z.object({ kind: ExportKind });

/** `POST /exports/kug200b_print`: the generated Kug 200b forms of one project, 1–100, each once. */
export const DocumentExportInput = z
  .strictObject({
    documentIds: z
      .array(z.uuid())
      .min(1)
      .max(exportLimits.kug200b_print)
      .refine((ids) => new Set(ids).size === ids.length, { params: { code: "duplicate_value" } }),
  })
  .meta({ id: "DocumentExportInput" });

/** `POST /exports/{kind}` of a batch's kind: one open batch of the PL's project. */
export const BatchExportInput = z
  .strictObject({ batchId: z.uuid() })
  .meta({ id: "BatchExportInput" });

/** The body by kind: forms for the print file, a batch for the batch's kinds. */
export const ExportInput = z
  .union([DocumentExportInput, BatchExportInput])
  .meta({ id: "ExportInput" });
export type ExportInput = z.infer<typeof ExportInput>;

/** The link: same origin, bound to the session that asked, valid 60 s. */
export const ExportLink = z
  .strictObject({
    url: z.string().startsWith("/api/v1/export-content/"),
    expiresAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
  })
  .meta({ id: "ExportLink" });
export type ExportLink = z.infer<typeof ExportLink>;

/** The link's token: 32 random bytes, base64url. */
export const ExportContentParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
