import { z } from "zod";

/**
 * `ta_only`: Transferagentur only (pre-phase, no DSV, no beE).
 * `ta_tg`: Transferagentur followed by a Transfergesellschaft.
 */
export const ProjectType = z.enum(["ta_only", "ta_tg"]).meta({
  id: "ProjectType",
  description: "ta_only: Transferagentur only. ta_tg: Transferagentur and Transfergesellschaft.",
});

export type ProjectType = z.infer<typeof ProjectType>;

/**
 * `draft`: setup, import and creation, but no post-creation lifecycle transition. `active`:
 * activated once its blockers are gone (Q98, round 22); one-way in Slice 2.
 */
export const ProjectStatus = z.enum(["draft", "active"]).meta({
  id: "ProjectStatus",
  description: "draft: setup only, no lifecycle transitions. active: activated (one-way).",
});

export type ProjectStatus = z.infer<typeof ProjectStatus>;

const requiredText = z.string().trim().min(1).max(200);

/**
 * Contractual dates live on the entry waves (Q79), so a project is created without dates. Strict:
 * an unknown field (a stale client's dates, a premature `projectAgenturKey`) is a validation
 * error, never silently dropped (round 23).
 */
export const CreateProjectInput = z
  .strictObject({
    name: requiredText,
    customerName: requiredText,
    type: ProjectType,
    /** The creator chooses the region (Q126); missing is the value rule `region_required`. */
    regionId: z.uuid().optional(),
  })
  .meta({ id: "CreateProjectInput" });

export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

/** A new project needs a region (Q126): without one only global roles would ever see it. */
export function projectCreationRefusals(input: CreateProjectInput): "region_required"[] {
  return input.regionId === undefined ? ["region_required"] : [];
}

/**
 * The Kug 200a's header (ba-forms.md, the Kug 200a as built): the T-Kug-Nummer as it follows the
 * form's printed `TK-` (never repeating it), the personalabgebender Betrieb's Betriebsnummer
 * (eight digits) and its Branche/Wirtschaftsklasse. Optional; null clears.
 */
export const TKugNumber = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z][0-9A-Za-z./-]{0,29}$/)
  .refine((value) => !/^TK-/i.test(value), { params: { code: "t_kug_prefix" } });
export const Betriebsnummer = z
  .string()
  .trim()
  .regex(/^[0-9]{8}$/);
export const EconomicClass = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\p{Cc}]*$/u);

const kug200aHeader = {
  tKugNumber: TKugNumber.nullable(),
  employerBetriebsnummer: Betriebsnummer.nullable(),
  employerEconomicClass: EconomicClass.nullable(),
};

/** The fields a PL may change; at least one; strict. Type changes follow `checkProjectUpdate`. */
export const UpdateProjectInput = z
  .strictObject({
    name: requiredText.optional(),
    customerName: requiredText.optional(),
    type: ProjectType.optional(),
    /** The PL only while draft, the global admin at any time (Q126, `regionChangeRefusal`). */
    regionId: z.uuid().optional(),
    tKugNumber: kug200aHeader.tKugNumber.optional(),
    employerBetriebsnummer: kug200aHeader.employerBetriebsnummer.optional(),
    employerEconomicClass: kug200aHeader.employerEconomicClass.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "Change at least one field",
    params: { code: "nothing_to_change" },
  })
  .meta({ id: "UpdateProjectInput" });

export type UpdateProjectInput = z.infer<typeof UpdateProjectInput>;

/** A project as the API returns it. */
export const Project = z
  .object({
    id: z.uuid(),
    name: z.string(),
    customerName: z.string(),
    type: ProjectType,
    status: ProjectStatus,
    projectAgenturKey: z
      .string()
      .nullable()
      .meta({ description: "The Project Agentur (the KuG-Agentur for ta_tg, Q90)" }),
    activatedAt: z.iso.datetime().nullable().meta({ description: "UTC timestamp (ISO 8601)" }),
    createdAt: z.iso.datetime().meta({ description: "UTC timestamp (ISO 8601)" }),
    createdBy: z.uuid().meta({ description: "Staff user id" }),
    regionId: z.uuid().nullable().meta({
      description:
        "The region (Niederlassung); null for a project from before regions, which only global roles see",
    }),
    ...kug200aHeader,
  })
  .meta({ id: "Project" });

export type Project = z.infer<typeof Project>;

export type ProjectUpdateRefusal =
  | "project_not_draft"
  | "project_has_participations"
  | "project_has_waves";

/**
 * Whether a change of the project's type is allowed (Q98, round 22): only while draft, and only
 * while the project has neither participations nor entry waves, because Slice 2 can't delete
 * waves and round 10's supersession on a change to `ta_only` isn't built. Name and customer may
 * always change.
 */
export function checkProjectUpdate(
  project: { status: ProjectStatus; type: ProjectType },
  usage: { participations: number; waves: number },
  change: { type?: ProjectType | undefined },
): ProjectUpdateRefusal[] {
  if (change.type === undefined || change.type === project.type) return [];
  const refusals: ProjectUpdateRefusal[] = [];
  if (project.status !== "draft") refusals.push("project_not_draft");
  if (usage.participations > 0) refusals.push("project_has_participations");
  if (usage.waves > 0) refusals.push("project_has_waves");
  return refusals;
}
