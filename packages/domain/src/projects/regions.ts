import { z } from "zod";

/**
 * Regions (Niederlassungen, Q35): reference data a global admin maintains (Q126). A project
 * belongs to one; regional org roles are granted per region. The code is short and upper case
 * (`NORD`, `BY-SUED`); the name is free text and never enters the audit trail.
 */
export const RegionCode = z.string().regex(/^[A-Z0-9](?:[A-Z0-9-]{0,18}[A-Z0-9])?$/);

const regionName = z.string().trim().min(1).max(100);

export const Region = z
  .strictObject({
    id: z.uuid(),
    code: RegionCode,
    name: z.string(),
    createdAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
  })
  .meta({ id: "Region" });
export type Region = z.infer<typeof Region>;

export const CreateRegionInput = z
  .strictObject({ code: RegionCode, name: regionName })
  .meta({ id: "CreateRegionInput" });
export type CreateRegionInput = z.infer<typeof CreateRegionInput>;

export const UpdateRegionInput = z
  .strictObject({ code: RegionCode.optional(), name: regionName.optional() })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "Change at least one field",
    params: { code: "nothing_to_change" },
  })
  .meta({ id: "UpdateRegionInput" });
export type UpdateRegionInput = z.infer<typeof UpdateRegionInput>;
