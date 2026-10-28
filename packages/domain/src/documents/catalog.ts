import { z } from "zod";
import type { DataClass, OrgRole, ParticipantRetentionClass, ProjectRole } from "../enums";
import type { AccessCategory } from "../fields/catalog";

/**
 * Document types (data-protection.md, documents; Q87 B; the first six are the ones completeness
 * rules name; `cv` from catalog version 2, Q142 *assumed*; `tl407_form` from version 3, Q179; the
 * signed TL 407's operations from version 4, Q184; the ASU proof's from version 5, Q186).
 */
export const DocumentType = z.enum([
  "tl407_signed_scan",
  "kug200b_signed_scan",
  "dsv_signed_scan",
  "dsv_cancellation",
  "asu_proof",
  "profiling_exception_evidence",
  "cv",
  "participant_upload",
  "qualification_certificate",
  "tl407_form",
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

/**
 * Who may add, review and delete documents of a type (Q146, *assumed*; data-protection.md,
 * documents). `undecided` until the type's slice decides its operations (Q65). A consultant
 * only for assigned participations; `participant`: their own participation, in the portal.
 */
export type DocumentOperations =
  | "undecided"
  /**
   * Written only by the platform's generation (`record_form_generation`; data-protection.md,
   * generated forms): never uploaded, reviewed or deleted by an ordinary operation.
   */
  | "generated"
  | {
      /**
       * Staff in normal mode as themselves, or in assisted mode on the participant's behalf; a
       * signed type in normal mode only.
       */
      add: readonly AccessRole[];
      /** Once and final; staff in normal mode. */
      review: readonly ProjectRole[];
      /**
       * Staff any document, with a reason code, in normal mode (a signed one only before its
       * review, as `wrong_person` or `wrong_file`); the participant only what they added
       * themselves while it isn't accepted.
       */
      delete: readonly AccessRole[];
    };

export type DocumentTypeEntry = {
  type: DocumentType;
  accessCategory: AccessCategory;
  /** The class of its most sensitive content. */
  dataClass: DataClass;
  /**
   * Of the raw file; periods `unset` until the DPO confirms them (Slice 7, ADR-0008). After
   * stage-one deletion only the minimum derived evidence facts stay (round 12).
   */
  retentionClass: ParticipantRetentionClass;
  /** Signed or submitted: never changed; a correction is a new version. */
  signed: boolean;
  /** Consultants only for assigned participations; `participant`: their own, in the portal. */
  roles: Partial<Record<AccessRole, DocumentRight>>;
  /** Whether the original file name is kept, as confidential metadata (Q148). */
  fileName: boolean;
  operations: DocumentOperations;
};

const profilerAndPl = { consultant: "open", project_lead: "open" } as const;
const undecided = { fileName: false, operations: "undecided" } as const;

/**
 * The participant's own documents (Q142, Q145, Q146, Q148, *assumed*): personnel-file
 * retention (not BA evidence), the file name kept; the participant, the assigned consultant and
 * the PL add them; the consultant and the PL review and delete. Back office none: certificates
 * not before Slice 8.
 */
const participantOwned = {
  accessCategory: "confidential",
  dataClass: "confidential",
  retentionClass: "personnel_file",
  signed: false,
  roles: { participant: "open", ...profilerAndPl },
  fileName: true,
  operations: {
    add: ["participant", "consultant", "project_lead"],
    review: ["consultant", "project_lead"],
    delete: ["participant", "consultant", "project_lead"],
  },
} as const;

/**
 * Version 5 (*assumed*; data-protection.md, documents): a new type or a changed rule is a new
 * version.
 * Version 2 adds `cv`, file names and the operations of the participant's own documents; version 3
 * the generated TL 407 (`tl407_form`, Q179); version 4 the signed TL 407's operations (Q183, Q184);
 * version 5 the ASU proof's (Q186).
 */
export const documentTypeCatalog = {
  version: 5,
  types: [
    {
      // The signed paper (data-protection.md, signed scans; Q183, Q184): the assigned consultant
      // and the PL add and review it in normal mode; only the PL deletes it, before its review.
      type: "tl407_signed_scan",
      accessCategory: "signed_tl407",
      dataClass: "special_category", // the health line of section C
      retentionClass: "evidence_set",
      signed: true,
      roles: profilerAndPl,
      fileName: false,
      operations: {
        add: ["consultant", "project_lead"],
        review: ["consultant", "project_lead"],
        delete: ["project_lead"],
      },
    },
    {
      type: "kug200b_signed_scan",
      accessCategory: "signed_kug200b",
      dataClass: "highly_confidential",
      retentionClass: "evidence_set",
      signed: true,
      roles: profilerAndPl,
      ...undecided,
    },
    ...(["dsv_signed_scan", "dsv_cancellation"] as const).map((type) => ({
      type,
      accessCategory: "employment_contract" as const,
      dataClass: "highly_confidential" as const,
      retentionClass: "personnel_file" as const,
      signed: true,
      roles: { project_lead: "open", back_office: "open" } as const,
      ...undecided,
    })),
    {
      // A BA confirmation of the registration (data-protection.md, the ASU record; Q186, the owner's
      // choice in PR 6-4a): evidence like signed paper, so `signed` (normal mode only, never
      // changed once reviewed). The assigned consultant and the PL add it (the PL can't open it),
      // the assigned consultant reviews it; only the PL deletes it, before its review.
      type: "asu_proof",
      accessCategory: "identifiers",
      dataClass: "highly_confidential",
      retentionClass: "participation_record",
      signed: true,
      roles: { consultant: "open", project_lead: "metadata_break_glass_open" },
      fileName: false,
      operations: {
        add: ["consultant", "project_lead"],
        review: ["consultant"],
        delete: ["project_lead"],
      },
    },
    {
      type: "profiling_exception_evidence",
      // health when medically related, else confidential: the stricter until Slice 6 tells them apart
      accessCategory: "health",
      dataClass: "special_category",
      retentionClass: "participation_record",
      signed: false,
      roles: {
        consultant: "open",
        project_lead: "assisted_or_break_glass",
        regional_operations_manager: "metadata",
      },
      ...undecided,
    },
    { type: "cv", ...participantOwned },
    { type: "participant_upload", ...participantOwned },
    // back office only when funding or settlement needs it: no such purpose before Slice 8
    { type: "qualification_certificate", ...participantOwned },
    {
      // The unsigned working copy (data-protection.md, generated forms; Q179): the signed type's
      // access category and class, the assigned consultant generates it, it opens only through
      // the logged opening and its file expires (`workingCopyExpiry`).
      type: "tl407_form",
      accessCategory: "signed_tl407",
      dataClass: "special_category",
      retentionClass: "form_working_copy",
      signed: false,
      roles: profilerAndPl,
      fileName: false,
      operations: "generated",
    },
  ] satisfies DocumentTypeEntry[],
};

const byType = new Map<DocumentType, DocumentTypeEntry>(
  documentTypeCatalog.types.map((entry) => [entry.type, entry]),
);

export function documentTypeEntry(type: DocumentType): DocumentTypeEntry {
  return byType.get(type)!;
}
