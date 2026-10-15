import { z } from "zod";
import { isoDate, isValidIsoDate } from "./iso-date";

/**
 * `ta_only`: Transferagentur only (pre-phase, no DSV, no beE).
 * `ta_tg`: Transferagentur followed by a Transfergesellschaft.
 */
export const ProjectType = z.enum(["ta_only", "ta_tg"]).meta({
  id: "ProjectType",
  description: "ta_only: Transferagentur only. ta_tg: Transferagentur and Transfergesellschaft.",
});

export type ProjectType = z.infer<typeof ProjectType>;

/** Stable codes for the cross-field rules, carried in the issue's `params.code`. */
export const projectRuleCodes = {
  tgEndBeforeStart: "tg_end_before_start",
  notAllowedForTaOnly: "not_allowed_for_ta_only",
} as const;

const TG_DATE_FIELDS = ["signingDeadline", "defaultTgStart", "defaultTgEnd"] as const;

const requiredText = z.string().trim().min(1).max(200);

export const CreateProjectInput = z
  .object({
    name: requiredText,
    customerName: requiredText,
    type: ProjectType,
    signingDeadline: isoDate.optional(),
    defaultTgStart: isoDate.optional(),
    defaultTgEnd: isoDate.optional(),
  })
  .superRefine((input, ctx) => {
    // A ta_only project has no DSV track and no beE (process-and-lifecycle.md),
    // so it has no signing deadline and no TG dates.
    if (input.type === "ta_only") {
      for (const field of TG_DATE_FIELDS) {
        if (input[field] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "Not allowed for a ta_only project",
            params: { code: projectRuleCodes.notAllowedForTaOnly },
          });
        }
      }
      return;
    }

    const { defaultTgStart: start, defaultTgEnd: end } = input;
    // Field-level issues don't abort this refinement, so skip dates that are already invalid.
    if (start && end && isValidIsoDate(start) && isValidIsoDate(end) && end < start) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultTgEnd"],
        message: "TG end must not be before TG start",
        params: { code: projectRuleCodes.tgEndBeforeStart },
      });
    }
  })
  .meta({ id: "CreateProjectInput" });

export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

/** A project as the API returns it. Dates are `null` when not set. */
export const Project = z
  .object({
    id: z.uuid(),
    name: z.string(),
    customerName: z.string(),
    type: ProjectType,
    signingDeadline: isoDate.nullable(),
    defaultTgStart: isoDate.nullable(),
    defaultTgEnd: isoDate.nullable(),
    createdAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
    createdBy: z.uuid().meta({ description: "Staff user id" }),
  })
  .meta({ id: "Project" });

export type Project = z.infer<typeof Project>;
