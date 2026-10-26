import { z } from "zod";

/** Data classification from docs/domain/data-protection.md, most sensitive first. */
export const DataClass = z
  .enum(["special_category", "highly_confidential", "confidential", "internal", "aggregated"])
  .meta({ id: "DataClass" });

export type DataClass = z.infer<typeof DataClass>;

/**
 * Organisation-wide roles (Q80, Q126): `admin` is global, the regional ones are granted per
 * region. They replace the flat staff role; there is no customer or participant role (Q47).
 */
export const OrgRole = z
  .enum(["admin", "regional_admin", "regional_operations_manager"])
  .meta({ id: "OrgRole" });
export type OrgRole = z.infer<typeof OrgRole>;

/** Project roles: zero or more per person and project; permissions are the union (Q61). */
export const ProjectRole = z
  .enum(["project_lead", "consultant", "back_office"])
  .meta({ id: "ProjectRole" });
export type ProjectRole = z.infer<typeof ProjectRole>;

/**
 * Retention classes of participant data items and documents (ADR-0008): retention is per item,
 * never per person. Periods stay `unset` until the DPO confirms them (Slice 7).
 */
export const ParticipantRetentionClass = z.enum([
  "participation_record",
  "personnel_file",
  "evidence_set",
  // The structured health and disability yes/no answers: 3 months after exit or with the
  // non-signer deletion (data-protection.md, retention; Q141)
  "health_record",
  // The generated, unsigned forms (data-protection.md, generated forms; Q179): the file goes 30
  // days after a newer generation or its accepted signed scan, 90 days after an abandoned
  // generation, 30 days after the participation's terminal status (`workingCopyExpiry`); the row
  // and its provenance stay as the tombstone
  "form_working_copy",
]);
export type ParticipantRetentionClass = z.infer<typeof ParticipantRetentionClass>;
