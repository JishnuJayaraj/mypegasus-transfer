import { z } from "zod";
import { ImportRowOutcome } from "./plan";
import { ImportIssueCode, ImportTarget } from "./targets";

// The import's API contract (Slice 2 plan 5.11, 5.12): the limits, the inputs of preview and
// confirm and what they answer. Shared by the API and the wizard. Nothing here carries a value
// the PL didn't see in their own file; issues carry row, target and code only.

/** The MVP limits (round 32, Q103 item 18): an oversized real file is escalated, never cut. */
export const importLimits = {
  fileBytes: 5 * 1024 * 1024,
  dataRows: 5000,
  columns: 50,
  cellCharacters: 500,
  /** The header row is one of the first rows (round 32). */
  headerRowChoices: 20,
} as const;

/** Why a file can't be read (a 422 at `/file`, never a value from the file). */
export const ImportFileErrorCode = z.enum([
  "file_too_large",
  "unsupported_file",
  "file_too_complex",
  "file_empty",
  "too_many_rows",
  "too_many_columns",
  "cell_too_long",
  "sheet_not_found",
  "header_row_invalid",
  "encoding_invalid",
  "csv_malformed",
]);
export type ImportFileErrorCode = z.infer<typeof ImportFileErrorCode>;

export const CsvDelimiter = z.enum([";", ",", "\t"]);
export const CsvEncoding = z.enum(["utf-8", "windows-1252"]);

/** A target as the report names it: `address` stands for street, postal code and city. */
export const ImportReportTarget = z.enum([...ImportTarget.options, "address"]);
export type ImportReportTarget = z.infer<typeof ImportReportTarget>;

/** A column of the file (0-based) and the target the PL maps it to. */
export const ColumnMapping = z.strictObject({
  column: z
    .int()
    .min(0)
    .max(importLimits.columns - 1),
  target: ImportTarget,
});
export type ColumnMapping = z.infer<typeof ColumnMapping>;

type Issue = {
  addIssue: (issue: {
    code: "custom";
    message: string;
    params: object;
    path: (string | number)[];
  }) => void;
};
const issue = (ctx: Issue, reason: string, path: (string | number)[]) =>
  ctx.addIssue({ code: "custom", message: reason, params: { code: reason }, path });

/** One column to one target; a column twice is refused here, a target twice by `checkMapping`. */
const mapping = z
  .array(ColumnMapping)
  .max(importLimits.columns)
  .superRefine((entries, ctx) => {
    const seen = new Set<number>();
    entries.forEach(({ column }, index) => {
      if (seen.has(column)) issue(ctx, "column_mapped_twice", [index, "column"]);
      seen.add(column);
    });
  });

const fileFields = {
  /** The file, base64 (the API takes only JSON); at most 5 MB decoded, checked after decoding. */
  file: z
    .string()
    .min(1)
    .max(8 * 1024 * 1024)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  /** The sheet of an Excel file (default the first). */
  sheet: z.string().min(1).max(255).optional(),
  /** The row of the header among the first 20 (default 1); title rows above it are dropped. */
  headerRow: z.int().min(1).max(importLimits.headerRowChoices).default(1),
  /** Overrides what was detected. */
  csv: z
    .strictObject({ delimiter: CsvDelimiter.optional(), encoding: CsvEncoding.optional() })
    .optional(),
  /** The whole-import country (round 32) when the file has no country column. */
  country: z.string().trim().min(1).max(100).nullable().optional(),
  /** The entry wave of every new participation. */
  waveId: z.uuid().optional(),
};

/** `POST /projects/{projectId}/imports/preview`: writes nothing. Without a mapping: suggestions. */
export const ImportPreviewInput = z
  .strictObject({ ...fileFields, mapping: mapping.optional() })
  .meta({ id: "ImportPreviewInput" });
export type ImportPreviewInput = z.infer<typeof ImportPreviewInput>;

/** What the PL decided (checked against the plan by `checkImportDecisions`). */
export const ImportDecisionsInput = z
  .strictObject({
    confirmWarnings: z.boolean(),
    possibleDuplicates: z.record(z.string().regex(/^[1-9]\d{0,5}$/), z.enum(["create", "skip"])),
  })
  .meta({ id: "ImportDecisions" });

export const PreviewToken = z.string().regex(/^[0-9a-f]{64}$/);

/** `POST /projects/{projectId}/imports`: the same file and options again, the mapping and the PL's decisions. */
export const ImportConfirmInput = z
  .strictObject({
    ...fileFields,
    mapping: mapping.min(1),
    decisions: ImportDecisionsInput,
    previewToken: PreviewToken,
  })
  .meta({ id: "ImportConfirmInput" });
export type ImportConfirmInput = z.infer<typeof ImportConfirmInput>;

export const ImportIssueView = z
  .strictObject({
    row: z.int().min(1).nullable(),
    target: ImportReportTarget.nullable(),
    code: ImportIssueCode,
    severity: z.enum(["error", "warning"]),
  })
  .meta({ id: "ImportIssue" });
export type ImportIssueView = z.infer<typeof ImportIssueView>;

/** A suggested column, and where the suggestion comes from (5.11). */
export const SuggestedColumn = z.strictObject({
  column: z.int().min(0),
  target: ImportTarget,
  source: z.enum(["project", "customer", "builtin"]),
});

/** An update's targets with the stored and the new value (round 32: the PL sees both). */
export const ImportChange = z.strictObject({
  target: ImportTarget,
  old: z.string().nullable(),
  new: z.string(),
});

/** The stored value an empty cell kept (Q103 item 11). */
export const ImportKept = z.strictObject({ target: ImportReportTarget, value: z.string() });

/** A row that needs the PL's attention; a clean row to create or leave unchanged is only counted. */
export const ImportReportRow = z
  .strictObject({
    row: z.int().min(1),
    outcome: ImportRowOutcome,
    /** The key, for the PL to find the row; absent where it is missing or invalid. */
    personnelNumber: z.string().optional(),
    issues: z.array(ImportIssueView),
    changes: z.array(ImportChange).optional(),
    kept: z.array(ImportKept).optional(),
  })
  .meta({ id: "ImportReportRow" });
export type ImportReportRow = z.infer<typeof ImportReportRow>;

export const ImportCounts = z
  .strictObject({
    /** Data rows in the file (empty rows aren't counted). */
    rows: z.int().min(0),
    create: z.int().min(0),
    update: z.int().min(0),
    unchanged: z.int().min(0),
    skip: z.int().min(0),
    error: z.int().min(0),
    warnings: z.int().min(0),
    /** Participations of the project the file doesn't contain: counted, never changed. */
    missing: z.int().min(0),
  })
  .meta({ id: "ImportCounts" });
export type ImportCounts = z.infer<typeof ImportCounts>;

export const ImportPreview = z
  .strictObject({
    format: z.enum(["xlsx", "csv"]),
    /** The sheets of an Excel file, hidden ones included; empty for a CSV. */
    sheets: z.array(z.string()),
    sheet: z.string().nullable(),
    /** What was detected or chosen, for the PL to check the umlauts. */
    csv: z.strictObject({ delimiter: CsvDelimiter, encoding: CsvEncoding }).nullable(),
    headerRow: z.int().min(1),
    /** The header cells as written in the file. */
    headers: z.array(z.string()),
    suggestedMapping: z.array(SuggestedColumn),
    /** The mapping this answer was made for (empty when none was sent). */
    mapping: z.array(ColumnMapping),
    /** The required targets the mapping lacks. */
    missingTargets: z.array(ImportReportTarget),
    mappingIssues: z.array(ImportIssueView),
    /** Null while the mapping has issues. */
    report: z.strictObject({ counts: ImportCounts, rows: z.array(ImportReportRow) }).nullable(),
    /** Only for a mapping without issues and a file without errors; the confirm sends it back. */
    previewToken: PreviewToken.nullable(),
  })
  .meta({ id: "ImportPreview" });
export type ImportPreview = z.infer<typeof ImportPreview>;

export const ImportResult = z
  .strictObject({
    created: z.int().min(0),
    updated: z.int().min(0),
    unchanged: z.int().min(0),
    skipped: z.int().min(0),
  })
  .meta({ id: "ImportResult" });
export type ImportResult = z.infer<typeof ImportResult>;
