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

/** Contractual dates live on the entry waves (Q79), so a project is created without dates. */
export const CreateProjectInput = z
  .object({ name: requiredText, customerName: requiredText, type: ProjectType })
  .meta({ id: "CreateProjectInput" });

export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

/** The fields a PL may change; at least one. Type changes follow `checkProjectUpdate`. */
export const UpdateProjectInput = z
  .object({
    name: requiredText.optional(),
    customerName: requiredText.optional(),
    type: ProjectType.optional(),
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

/**
 * Who may create a project until Slice 3 (Q106, round 22): staff whose flat role is
 * `project_lead`; the creator becomes the project's PL member.
 */
export function mayCreateProject(staffRole: string): boolean {
  return staffRole === "project_lead";
}
