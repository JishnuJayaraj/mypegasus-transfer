import { z } from "zod";

// Exports (data-protection.md, exports; ADR-0010, exports; Q159): a logged request
// (`export_created`) answers a link valid 60 seconds for the asking session; the download
// re-authorizes the viewer and every included item, renders the output at that moment from
// immutable inputs, stores no export file and is audited itself (`export_downloaded`).

/** The kinds of export: `kug200b_print`, one print file of generated Kug 200b forms. */
export const ExportKind = z.enum(["kug200b_print"]).meta({ id: "ExportKind" });
export type ExportKind = z.infer<typeof ExportKind>;

/** The bounds (data-protection.md, exports): a print file holds at most 100 forms. */
export const exportLimits = { kug200b_print: 100 } as const satisfies Record<ExportKind, number>;

export const ExportParams = z.object({ kind: ExportKind });

/** `POST /exports/kug200b_print`: the generated Kug 200b forms of one project, 1–100, each once. */
export const ExportInput = z
  .strictObject({
    documentIds: z
      .array(z.uuid())
      .min(1)
      .max(exportLimits.kug200b_print)
      .refine((ids) => new Set(ids).size === ids.length, { params: { code: "duplicate_value" } }),
  })
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
