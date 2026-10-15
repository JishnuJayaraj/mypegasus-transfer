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
