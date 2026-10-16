import { z } from "zod";

/** Data classification from docs/domain/data-protection.md, most sensitive first. */
export const DataClass = z
  .enum(["special_category", "highly_confidential", "confidential", "internal", "aggregated"])
  .meta({ id: "DataClass" });

export type DataClass = z.infer<typeof DataClass>;

/**
 * Staff roles. Provisional: Slice 1 owns the final role and assignment model (ADR-0007).
 * The customer has no login in the MVP (Q47); participants are not staff.
 */
export const StaffRole = z
  .enum(["admin", "regional_admin", "project_lead", "consultant", "back_office"])
  .meta({ id: "StaffRole" });

export type StaffRole = z.infer<typeof StaffRole>;

/** Organisation-wide roles, scoped to regions or all (D6, Q80). Replace `StaffRole` in Slice 3. */
export const OrgRole = z.enum(["admin", "regional_admin", "regional_operations_manager"]);
export type OrgRole = z.infer<typeof OrgRole>;

/** Project roles: zero or more per person and project; permissions are the union (D6, Q61). */
export const ProjectRole = z.enum(["project_lead", "consultant", "back_office"]);
export type ProjectRole = z.infer<typeof ProjectRole>;

/**
 * Retention classes of participant data items and documents (ADR-0008): retention is per item,
 * never per person. Periods stay `unset` until the DPO confirms them (Slice 7).
 */
export const ParticipantRetentionClass = z.enum([
  "participation_record",
  "personnel_file",
  "evidence_set",
]);
export type ParticipantRetentionClass = z.infer<typeof ParticipantRetentionClass>;
