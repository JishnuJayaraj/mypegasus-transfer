import { z } from "zod";
import type { DataClass, OrgRole, ProjectRole } from "../enums";
import type { AccessCategory } from "../fields/catalog";

/** Document types (round 11, Q87 B; the first six are the completeness types of plan 5.5). */
export const DocumentType = z.enum([
  "tl407_signed_scan",
  "kug200b_signed_scan",
  "dsv_signed_scan",
  "dsv_cancellation",
  "asu_proof",
  "profiling_exception_evidence",
  "participant_upload",
  "qualification_certificate",
]);
export type DocumentType = z.infer<typeof DocumentType>;

export type AccessRole = "participant" | ProjectRole | OrgRole;

/**
 * What a role may do with a document type; a role not listed gets nothing.
 * - `open`: metadata, and the file through an explicit, logged opening
 * - `metadata`: metadata only (e.g. "evidence present")
 * - `metadata_break_glass_open`: metadata; the file only through break-glass
 * - `assisted_or_break_glass`: metadata and file only in assisted mode or through break-glass
 */
export type DocumentRight =
  | "open"
  | "metadata"
  | "metadata_break_glass_open"
  | "assisted_or_break_glass";

export type DocumentTypeEntry = {
  type: DocumentType;
  accessCategory: AccessCategory;
  /** The class of its most sensitive content. */
  dataClass: DataClass;
  /** Periods are `unset` until the DPO confirms them (Slice 7, ADR-0008). */
  retentionClass: "evidence_set" | "personnel_file" | "participation_record";
  /** Signed or submitted: never changed; a correction is a new version. */
  signed: boolean;
  /** Consultants only for assigned participations; `participant`: their own, in the portal. */
  roles: Partial<Record<AccessRole, DocumentRight>>;
};

const profilerAndPl = { consultant: "open", project_lead: "open" } as const;

/** Version 1 (round 11, *assumed*): a new type or a changed rule is a new version. */
export const documentTypeCatalog = {
  version: 1,
  types: [
    {
      type: "tl407_signed_scan",
      accessCategory: "signed_tl407",
      dataClass: "special_category", // the health line of section C
      retentionClass: "evidence_set",
      signed: true,
      roles: profilerAndPl,
    },
    {
      type: "kug200b_signed_scan",
      accessCategory: "signed_kug200b",
      dataClass: "highly_confidential",
      retentionClass: "evidence_set",
      signed: true,
      roles: profilerAndPl,
    },
    ...(["dsv_signed_scan", "dsv_cancellation"] as const).map((type) => ({
      type,
      accessCategory: "employment_contract" as const,
      dataClass: "highly_confidential" as const,
      retentionClass: "personnel_file" as const,
      signed: true,
      roles: { project_lead: "open", back_office: "open" } as const,
    })),
    {
      type: "asu_proof",
      accessCategory: "identifiers",
      dataClass: "highly_confidential",
      retentionClass: "participation_record",
      signed: false,
      roles: { consultant: "open", project_lead: "metadata_break_glass_open" },
    },
    {
      type: "profiling_exception_evidence",
      // health when medically related, otherwise confidential: the stricter until 4b tells them apart
      accessCategory: "health",
      dataClass: "special_category",
      retentionClass: "participation_record",
      signed: false,
      roles: {
        consultant: "open",
        project_lead: "assisted_or_break_glass",
        regional_operations_manager: "metadata",
      },
    },
    {
      type: "participant_upload",
      accessCategory: "confidential",
      dataClass: "confidential",
      retentionClass: "participation_record",
      signed: false,
      roles: { participant: "open", ...profilerAndPl },
    },
    {
      // back office only when funding or settlement needs it: no such purpose before Slice 8
      type: "qualification_certificate",
      accessCategory: "confidential",
      dataClass: "confidential",
      retentionClass: "participation_record",
      signed: false,
      roles: { participant: "open", ...profilerAndPl },
    },
  ] satisfies DocumentTypeEntry[],
};

const byType = new Map<DocumentType, DocumentTypeEntry>(
  documentTypeCatalog.types.map((entry) => [entry.type, entry]),
);

export function documentTypeEntry(type: DocumentType): DocumentTypeEntry {
  return byType.get(type)!;
}
